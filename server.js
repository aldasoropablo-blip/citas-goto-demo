const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const citas = [];
const solicitudesIvr = [];
let folioCounter = 1;

const CALENDAR_TIMEZONE = "America/Mexico_City";
const APPOINTMENT_MINUTES = 60;
const BASE_HOURS = ["13:00", "15:00", "17:00"];
const PROPERTY_DETAILS = [
  { id: "1", nombre: "Departamento en Polanco", ubicacion: "Campos Eliseos, Polanco, Miguel Hidalgo, CDMX", tipo: "Departamento residencial premium", precio: "$5,800,000 MXN", horario: "13:00" },
  { id: "2", nombre: "Casa en Coyoacan", nombreVisible: "Casa en Coyoacán", ubicacion: "Barrio de Santa Catarina, Coyoacan, CDMX", ubicacionVisible: "Barrio de Santa Catarina, Coyoacán, CDMX", tipo: "Casa familiar", precio: "$8,200,000 MXN", horario: "15:00" },
  { id: "3", nombre: "Oficina en Santa Fe", ubicacion: "Avenida Santa Fe, Cuajimalpa, CDMX", tipo: "Oficina corporativa", precio: "$45,000 MXN / mes", horario: "17:00" },
  { id: "4", nombre: "Penthouse en Interlomas", ubicacion: "Jesus del Monte, Interlomas, Huixquilucan, Estado de Mexico", ubicacionVisible: "Jesús del Monte, Interlomas, Huixquilucan, Estado de México", tipo: "Penthouse premium", precio: "$14,900,000 MXN", horario: null }
];
const CALENDAR_PROPERTIES = PROPERTY_DETAILS.map((property) => property.nombreVisible || property.nombre);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.type("text/plain").send("ok"));

app.get("/api/citas", (req, res) => {
  const q = clean(req.query.q).toLowerCase();
  const rows = q ? citas.filter((cita) => [cita.folio, cita.nombre, cita.telefono, cita.correo].filter(Boolean).some((value) => String(value).toLowerCase().includes(q))) : citas;
  res.json(rows);
});

app.get("/api/citas/:folio", (req, res) => {
  const cita = findCita(req.params.folio);
  if (!cita) return res.status(404).json({ error: "Cita no encontrada" });
  res.json(cita);
});

app.post("/api/citas", async (req, res) => {
  const { nombre, telefono, correo, tipo, fecha, hora } = req.body;
  if (!nombre || !telefono || !correo || !tipo || !fecha || !hora) return res.status(400).json({ error: "nombre, telefono, correo, tipo, fecha y hora son obligatorios" });
  const cita = await createAppointment(req.body);
  res.status(201).json(cita);
});

app.patch("/api/citas/:folio", (req, res) => {
  const cita = findCita(req.params.folio);
  if (!cita) return res.status(404).json({ error: "Cita no encontrada" });
  ["fecha", "hora", "estatus", "tipo", "comentarios"].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) cita[field] = clean(req.body[field]);
  });
  if (Object.prototype.hasOwnProperty.call(req.body, "propiedad")) {
    cita.propiedad = normalizePropertyName(req.body.propiedad);
    cita.ubicacion = getPropertyLocation(req.body.propiedad);
  }
  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);
  res.json(cita);
});

app.patch("/api/citas/:folio/cancelar", async (req, res) => {
  const cita = findCita(req.params.folio);
  if (!cita) return res.status(404).json({ error: "Cita no encontrada" });
  const result = await cancelAppointment(cita);
  res.json({ ...cita, ...result });
});

app.get("/api/ivr/citas/:folio", (req, res) => {
  const cita = findCita(req.params.folio);
  res.json(cita ? toIvrCitaResponse(cita) : ivrNotFound());
});

app.patch("/api/ivr/citas/:folio/cancelar", async (req, res) => {
  const cita = findCita(req.params.folio);
  if (!cita) return res.json(ivrNotFound());
  const result = await cancelAppointment(cita);
  res.json({ ok: true, found: true, action: "cancelar", folio: cita.folio, estatus: cita.estatus, calendarReleased: result.calendarReleased, message: "Tu cita fue cancelada correctamente." });
});

app.patch("/api/ivr/citas/:folio/confirmar", async (req, res) => updateIvrStatus(req, res, "Confirmada", "confirmar", "Tu asistencia fue confirmada correctamente."));
app.patch("/api/ivr/citas/:folio/reagendar", async (req, res) => rescheduleIvr(req, res, findCita(req.params.folio), { folio: true }));

app.get("/api/ivr/clientes/:telefono/cita", (req, res) => {
  const cita = findLatestCitaByTelefono(req.params.telefono);
  res.json(cita ? toPhoneIvrCitaResponse(cita, req.params.telefono) : phoneIvrNotFound());
});

app.patch("/api/ivr/clientes/:telefono/cita/confirmar", async (req, res) => {
  const cita = findLatestCitaByTelefono(req.params.telefono);
  if (!cita) return res.json(phoneIvrNotFound());
  cita.estatus = "Confirmada";
  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);
  await sendIvrActionEmails(cita, "confirmar", "Tu cita fue confirmada correctamente.");
  res.json({ ok: true, found: true, action: "confirmar", telefono: clean(req.params.telefono), folio: cita.folio, estatus: cita.estatus, message: "Tu cita fue confirmada correctamente." });
});

app.patch("/api/ivr/clientes/:telefono/cita/cancelar", async (req, res) => {
  const cita = findLatestCitaByTelefono(req.params.telefono);
  if (!cita) return res.json(phoneIvrNotFound());
  const result = await cancelAppointment(cita);
  res.json({ ok: true, found: true, action: "cancelar", telefono: clean(req.params.telefono), folio: cita.folio, estatus: cita.estatus, calendarReleased: result.calendarReleased, message: "Tu cita fue cancelada correctamente." });
});

app.patch("/api/ivr/clientes/:telefono/cita/reagendar", async (req, res) => rescheduleIvr(req, res, findLatestCitaByTelefono(req.params.telefono), { telefono: clean(req.params.telefono) }));

app.get("/api/ivr/propiedades/horarios", (req, res) => res.json({ ok: true, propiedades: getIvrPropertySchedules() }));

app.get("/api/calendar/availability", async (req, res) => {
  try {
    res.json(await getCalendarAvailability(clean(req.query.fecha) || todayInCalendarTimezone()));
  } catch (error) {
    console.error("Disponibilidad de Calendar no disponible:", error.message);
    res.status(503).json({ ok: false, message: "Disponibilidad temporalmente no disponible." });
  }
});

app.post("/api/calendar/book", async (req, res) => {
  const nombre = clean(req.body.nombre);
  const telefono = clean(req.body.telefono);
  const correo = clean(req.body.correo);
  const propiedad = normalizePropertyName(req.body.propiedad);
  const fecha = clean(req.body.fecha);
  const hora = clean(req.body.hora);
  if (!nombre || !telefono || !correo || !propiedad || !fecha || !hora) return res.status(400).json({ error: "nombre, telefono, correo, propiedad, fecha y hora son obligatorios" });

  try {
    const availability = await getCalendarAvailability(fecha);
    if (!isSlotAvailable(availability, propiedad, hora)) return res.status(409).json({ error: "Ese horario acaba de ocuparse. Por favor selecciona otro horario disponible." });
    const folio = nextFolio();
    const calendarEventId = await createCalendarEvent({ folio, nombre, telefono, correo, fecha, hora, comentarios: clean(req.body.comentarios) }, propiedad);
    const cita = await createAppointment({ ...req.body, folio, calendarEventId, tipo: clean(req.body.tipo) || "Visita a propiedad", comentarios: appendPropertyToComments(req.body.comentarios, propiedad), propiedad });
    res.status(201).json(cita);
  } catch (error) {
    console.error("No se pudo reservar en Google Calendar:", error.message);
    res.status(503).json({ ok: false, message: "Disponibilidad temporalmente no disponible." });
  }
});

app.post("/api/ivr/solicitudes", async (req, res) => {
  const telefono = clean(req.body.telefono);
  if (!telefono) return res.status(400).json({ ok: false, error: "telefono es obligatorio" });
  const solicitud = { telefono, propiedad: normalizePropertyInterest(req.body.propiedad), origen: clean(req.body.origen) || "GoTo IVR", createdAt: new Date().toISOString() };
  solicitudesIvr.push(solicitud);
  await sendIvrContactRequestEmail(solicitud);
  res.json({ ok: true, action: "solicitud_contacto", message: "Hemos registrado tu solicitud. Un asesor de Inmobiliaria Carvalho se pondra en contacto contigo a la brevedad." });
});

app.listen(PORT, () => console.log(`Citas GoTo demo escuchando en puerto ${PORT}`));

function nextFolio() { const value = String(folioCounter).padStart(6, "0"); folioCounter += 1; return `CITA-${value}`; }
function clean(value) { return String(value || "").trim(); }
function normalizePhone(value) { return String(value || "").replace(/\D/g, ""); }
function comparablePhone(value) { const phone = normalizePhone(value); return phone.length > 10 ? phone.slice(-10) : phone; }
function phonesMatch(left, right) { const l = normalizePhone(left); const r = normalizePhone(right); return Boolean(l && r && (l === r || comparablePhone(l) === comparablePhone(r))); }
function normalizeTextKey(value) { return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function findPropertyDetails(value) { const key = normalizeTextKey(value); return PROPERTY_DETAILS.find((property) => normalizeTextKey(property.nombre) === key || normalizeTextKey(property.nombreVisible) === key); }
function normalizePropertyName(value) { const property = findPropertyDetails(value); return property ? property.nombreVisible || property.nombre : clean(value); }
function getPropertyLocation(value) { const property = findPropertyDetails(value); return property ? property.ubicacionVisible || property.ubicacion : ""; }
function findCita(folio) { return citas.find((cita) => cita.folio.toLowerCase() === String(folio).toLowerCase()); }
function findLatestCitaByTelefono(telefono) { return citas.filter((cita) => phonesMatch(cita.telefono, telefono)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null; }
function ivrNotFound() { return { ok: true, found: false, message: "No encontramos una cita con ese folio." }; }
function phoneIvrNotFound() { return { ok: true, found: false, message: "No encontramos una cita asociada a ese numero telefonico." }; }
function toIvrCitaResponse(cita) { return { ok: true, found: true, folio: cita.folio, nombre: cita.nombre, telefono: cita.telefono, correo: cita.correo, tipo: cita.tipo, fecha: cita.fecha, hora: cita.hora, estatus: cita.estatus }; }
function toPhoneIvrCitaResponse(cita, telefono) { return { ok: true, found: true, telefono: clean(telefono), folio: cita.folio, nombre: cita.nombre, correo: cita.correo, tipo: cita.tipo, fecha: cita.fecha, hora: cita.hora, estatus: cita.estatus }; }

async function createAppointment(payload) {
  const cita = {
    folio: clean(payload.folio) || nextFolio(),
    nombre: clean(payload.nombre), telefono: clean(payload.telefono), correo: clean(payload.correo), tipo: clean(payload.tipo),
    propiedad: normalizePropertyName(payload.propiedad), ubicacion: getPropertyLocation(payload.propiedad), fecha: clean(payload.fecha), hora: clean(payload.hora),
    comentarios: clean(payload.comentarios), estatus: clean(payload.estatus) || "Confirmada", calendarEventId: clean(payload.calendarEventId), whatsappUrl: "",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  cita.whatsappUrl = buildWhatsAppUrl(cita);
  citas.push(cita);
  const emailResult = await sendAppointmentEmails(cita);
  cita.emailSent = emailResult.emailSent;
  cita.internalEmailSent = emailResult.internalEmailSent;
  return cita;
}

async function updateIvrStatus(req, res, estatus, action, message) {
  const cita = findCita(req.params.folio);
  if (!cita) return res.json(ivrNotFound());
  cita.estatus = estatus; cita.updatedAt = new Date().toISOString(); cita.whatsappUrl = buildWhatsAppUrl(cita);
  await sendIvrActionEmails(cita, action, message);
  res.json({ ok: true, found: true, action, folio: cita.folio, estatus: cita.estatus, message });
}

async function rescheduleIvr(req, res, cita, context) {
  const fecha = clean(req.body.fecha); const hora = clean(req.body.hora);
  if (!cita) return res.json(context.folio ? ivrNotFound() : phoneIvrNotFound());
  if (!fecha || !hora) return res.status(400).json({ ok: false, error: "fecha y hora son obligatorias" });
  cita.fecha = fecha; cita.hora = hora; cita.estatus = "Reagendada"; cita.updatedAt = new Date().toISOString(); cita.whatsappUrl = buildWhatsAppUrl(cita);
  await sendIvrActionEmails(cita, "reagendar", "Tu cita fue reagendada correctamente.");
  res.json({ ok: true, found: true, action: "reagendar", telefono: context.telefono, folio: cita.folio, fecha: cita.fecha, hora: cita.hora, estatus: cita.estatus, message: "Tu cita fue reagendada correctamente." });
}

function getIvrPropertySchedules() { return PROPERTY_DETAILS.map((property) => ({ id: property.id, nombre: property.nombreVisible || property.nombre, ubicacion: property.ubicacionVisible || property.ubicacion, tipo: property.tipo, disponible: Boolean(property.horario), horarios: property.horario ? [property.horario] : [], message: property.horario ? undefined : "Agenda llena" })); }
function normalizePropertyInterest(value) { const map = { 1: "Departamento en Polanco", 2: "Casa en Coyoacán", 3: "Oficina en Santa Fe", 4: "Penthouse en Interlomas" }; const propiedad = clean(value); return normalizePropertyName(map[propiedad] || propiedad || "No especificada"); }
function todayInCalendarTimezone() { return new Intl.DateTimeFormat("en-CA", { timeZone: CALENDAR_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function appendPropertyToComments(comentarios, propiedad) { const base = clean(comentarios); const line = `Propiedad: ${propiedad}`; return base.includes(line) ? base : base ? `${line}\n${base}` : line; }

async function getCalendarAvailability(fecha) {
  ensureCalendarConfig();
  const events = await fetchCalendarEvents(fecha);
  const properties = CALENDAR_PROPERTIES.map((nombre) => { const detail = findPropertyDetails(nombre); const slots = BASE_HOURS.map((hora) => buildAvailabilitySlot(fecha, hora, events)); return { nombre, ubicacion: detail ? detail.ubicacionVisible || detail.ubicacion : "", tipo: detail ? detail.tipo : "", agendaLlena: slots.every((slot) => slot.status !== "disponible"), slots }; });
  return { ok: true, fecha, timezone: CALENDAR_TIMEZONE, properties };
}
function buildAvailabilitySlot(fecha, hora, events) { const start = slotDate(fecha, hora); const end = addMinutes(start, APPOINTMENT_MINUTES); return events.some((event) => rangesOverlap(start, end, event.start, event.end)) ? { hora, status: "ocupado", label: "Ocupado", available: false } : { hora, status: "disponible", label: "Disponible", available: true }; }
function isSlotAvailable(availability, propiedad, hora) { const property = availability.properties.find((item) => normalizeTextKey(item.nombre) === normalizeTextKey(propiedad)); const slot = property && property.slots.find((item) => item.hora === hora); return Boolean(slot && slot.available); }

async function fetchCalendarEvents(fecha) {
  const token = await getGoogleAccessToken(); const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
  const params = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin: `${fecha}T00:00:00-06:00`, timeMax: `${fecha}T23:59:59-06:00` });
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Google Calendar respondio ${response.status}`);
  const data = await response.json();
  return (data.items || []).filter((event) => event.status !== "cancelled" && event.start && event.end && event.start.dateTime && event.end.dateTime).map((event) => ({ id: event.id, summary: event.summary || "", description: event.description || "", extendedProperties: event.extendedProperties || {}, start: new Date(event.start.dateTime), end: new Date(event.end.dateTime) }));
}

async function createCalendarEvent(cita, propiedad) {
  ensureCalendarConfig(); const token = await getGoogleAccessToken(); const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID); const startDate = slotDate(cita.fecha, cita.hora); const endDate = addMinutes(startDate, APPOINTMENT_MINUTES);
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ summary: `Visita Carvalho - ${propiedad}`, description: [`Folio: ${cita.folio}`, `Nombre: ${cita.nombre}`, `Telefono: ${cita.telefono}`, `Correo: ${cita.correo}`, `Propiedad: ${propiedad}`, `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, cita.comentarios ? `Comentarios: ${cita.comentarios}` : ""].filter(Boolean).join("\n"), start: { dateTime: toCalendarDateTime(startDate), timeZone: CALENDAR_TIMEZONE }, end: { dateTime: toCalendarDateTime(endDate), timeZone: CALENDAR_TIMEZONE }, extendedProperties: { private: { folio: cita.folio, source: "carvalho", telefono: cita.telefono, correo: cita.correo, propiedad } } }) });
  if (!response.ok) throw new Error(`Google Calendar no creo el evento: ${response.status}`);
  const data = await response.json(); console.log(`Calendar event created for ${cita.folio}`); return data.id;
}

async function cancelAppointment(cita) { cita.estatus = "Cancelada"; cita.updatedAt = new Date().toISOString(); cita.whatsappUrl = buildWhatsAppUrl(cita); const emailResult = await sendIvrActionEmails(cita, "cancelar", "Tu cita fue cancelada correctamente."); const calendarResult = await cancelCalendarEventForAppointment(cita); cita.emailSent = emailResult.emailSent; cita.internalEmailSent = emailResult.internalEmailSent; return { ...emailResult, ...calendarResult }; }
async function cancelCalendarEventForAppointment(cita) { try { ensureCalendarConfig(); } catch { return { calendarReleased: false, calendarMessage: "Google Calendar no configurado." }; } try { const eventId = cita.calendarEventId || await findCalendarEventForAppointment(cita); if (!eventId) { console.log("Calendar event not found or ambiguous for cancelled appointment"); return { calendarReleased: false, calendarMessage: "Calendar event not found or ambiguous for cancelled appointment" }; } await deleteCalendarEvent(eventId); cita.calendarEventId = ""; console.log(`Calendar event cancelled for ${cita.folio}`); return { calendarReleased: true }; } catch (error) { console.error(`Calendar event cancellation failed for ${cita.folio}: ${error.message}`); return { calendarReleased: false, calendarMessage: "No se pudo liberar Google Calendar." }; } }
async function findCalendarEventForAppointment(cita) { const events = await fetchCalendarEvents(cita.fecha); const slot = slotDate(cita.fecha, cita.hora); const matches = events.filter((event) => { const text = `${event.summary}\n${event.description}\n${JSON.stringify(event.extendedProperties)}`; const sameTime = Math.abs(event.start.getTime() - slot.getTime()) < 60000; const hasFolio = cita.folio && text.includes(cita.folio); const hasCorreo = cita.correo && text.toLowerCase().includes(cita.correo.toLowerCase()); const hasTelefono = cita.telefono && normalizePhone(text).includes(comparablePhone(cita.telefono)); const hasProperty = cita.propiedad && normalizeTextKey(text).includes(normalizeTextKey(cita.propiedad)); return sameTime && (hasFolio || (hasCorreo && hasTelefono && hasProperty)); }); return matches.length === 1 ? matches[0].id : ""; }
async function deleteCalendarEvent(eventId) { const token = await getGoogleAccessToken(); const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID); const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error(`Google Calendar respondio ${response.status}`); }

function ensureCalendarConfig() { if (!process.env.GOOGLE_CALENDAR_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) throw new Error("Google Calendar no configurado"); }
async function getGoogleAccessToken() { const now = Math.floor(Date.now() / 1000); const header = { alg: "RS256", typ: "JWT" }; const payload = { iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }; const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`; const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"); const signature = crypto.createSign("RSA-SHA256").update(unsignedToken).sign(privateKey); const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsignedToken}.${base64Url(signature)}` }) }); if (!response.ok) throw new Error(`Google OAuth respondio ${response.status}`); return (await response.json()).access_token; }
function base64Url(value) { const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value); return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function slotDate(fecha, hora) { return new Date(`${fecha}T${hora}:00-06:00`); }
function addMinutes(date, minutes) { return new Date(date.getTime() + minutes * 60000); }
function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) { return leftStart < rightEnd && leftEnd > rightStart; }
function toCalendarDateTime(date) { const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: CALENDAR_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`; }

function createSmtpTransporter() { const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env; if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !process.env.FROM_EMAIL) return null; return nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT), secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || Number(SMTP_PORT) === 465, connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000, auth: { user: SMTP_USER, pass: SMTP_PASS } }); }
function buildWhatsAppUrl(cita) { const phone = cita.telefono.replace(/[^\d]/g, ""); const message = [`Hola, ${cita.nombre}. Tu cita con Inmobiliaria Carvalho fue registrada correctamente.`, "", `Folio: ${cita.folio}`, cita.propiedad ? `Propiedad: ${cita.propiedad}` : "", cita.ubicacion ? `Ubicacion: ${cita.ubicacion}` : "", `Tipo de cita: ${cita.tipo}`, `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, "", "Para cambios o seguimiento, conserva tu folio y contacta a un asesor."].filter(Boolean).join("\n"); return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`; }

async function sendAppointmentEmails(cita) { if (process.env.RESEND_API_KEY) return sendAppointmentEmailsWithResend(cita); const transporter = createSmtpTransporter(); if (!transporter) { console.log(`Correo omitido para ${cita.folio}: variables SMTP incompletas.`); return { emailSent: false, internalEmailSent: false }; } const emailSent = await sendCustomerConfirmation(transporter, cita, process.env.FROM_EMAIL); const internalEmailSent = await sendInternalNotification(transporter, cita, process.env.FROM_EMAIL); return { emailSent, internalEmailSent }; }
async function sendAppointmentEmailsWithResend(cita) { if (!process.env.FROM_EMAIL) return { emailSent: false, internalEmailSent: false }; const emailSent = await sendResendEmail({ to: cita.correo, subject: `Confirmacion de cita ${cita.folio}`, text: customerEmailText(cita), logOk: `Email confirmation sent for ${cita.folio}`, logFail: `Email confirmation failed for ${cita.folio}` }); const internalEmailSent = process.env.INTERNAL_NOTIFY_EMAIL ? await sendResendEmail({ to: process.env.INTERNAL_NOTIFY_EMAIL, subject: `Nueva cita inmobiliaria ${cita.folio}`, text: internalEmailText(cita), logOk: `Internal notification sent for ${cita.folio}`, logFail: `Internal notification failed for ${cita.folio}` }) : false; return { emailSent, internalEmailSent }; }
async function sendResendEmail({ to, subject, text, logOk, logFail }) { try { const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: process.env.FROM_EMAIL, to, subject, text }) }); if (!response.ok) throw new Error(`Resend respondio ${response.status}`); console.log(logOk); return true; } catch (error) { console.error(`${logFail}: ${formatMailError(error)}`); return false; } }
function formatMailError(error) { const message = String(error && error.message || error || ""); return /timeout|timed out|etimedout|esocket/i.test(message) ? "connection timeout" : message; }
async function sendIvrActionEmails(cita, action, message) { const transporter = createSmtpTransporter(); if (!transporter) { console.log(`Correo IVR omitido para ${cita.folio}: variables SMTP incompletas.`); return { emailSent: false, internalEmailSent: false }; } const emailSent = await sendIvrCustomerEmail(transporter, cita, process.env.FROM_EMAIL, action, message); const internalEmailSent = await sendIvrInternalEmail(transporter, cita, process.env.FROM_EMAIL, action, message); return { emailSent, internalEmailSent }; }
async function sendIvrCustomerEmail(transporter, cita, fromEmail, action, message) { if (!cita.correo) return false; try { await transporter.sendMail({ from: fromEmail, to: cita.correo, subject: `Actualizacion de cita ${cita.folio}`, text: [`Nombre: ${cita.nombre}`, `Folio: ${cita.folio}`, `Accion: ${action}`, `Estatus: ${cita.estatus}`, `Tipo de cita: ${cita.tipo}`, `Propiedad: ${cita.propiedad || "Por confirmar"}`, `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, "", message].filter(Boolean).join("\n") }); console.log(`Email confirmation sent for ${cita.folio}`); return true; } catch (error) { console.error(`Email confirmation failed for ${cita.folio}: ${formatMailError(error)}`); return false; } }
async function sendIvrInternalEmail(transporter, cita, fromEmail, action, message) { if (!process.env.INTERNAL_NOTIFY_EMAIL) return false; try { await transporter.sendMail({ from: fromEmail, to: process.env.INTERNAL_NOTIFY_EMAIL, subject: `Actualizacion de cita ${cita.folio}`, text: [`Folio: ${cita.folio}`, `Accion: ${action}`, `Mensaje: ${message}`, `Nombre del cliente: ${cita.nombre}`, `Telefono: ${cita.telefono}`, `Correo: ${cita.correo}`, `Tipo de cita: ${cita.tipo}`, `Propiedad: ${cita.propiedad || "Por confirmar"}`, `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, `Comentarios: ${cita.comentarios || "Sin comentarios"}`, `Estatus: ${cita.estatus}`, `Actualizado: ${cita.updatedAt}`].join("\n") }); console.log(`Internal notification sent for ${cita.folio}`); return true; } catch (error) { console.error(`Internal notification failed for ${cita.folio}: ${formatMailError(error)}`); return false; } }
async function sendIvrContactRequestEmail(solicitud) { if (!process.env.INTERNAL_NOTIFY_EMAIL) return false; const transporter = createSmtpTransporter(); if (!transporter) return false; try { await transporter.sendMail({ from: process.env.FROM_EMAIL, to: process.env.INTERNAL_NOTIFY_EMAIL, subject: "Nueva solicitud por IVR - Inmobiliaria Carvalho", text: [`Telefono: ${solicitud.telefono}`, `Propiedad de interes: ${solicitud.propiedad}`, `Origen: ${solicitud.origen}`, `Fecha de solicitud: ${solicitud.createdAt}`, "Accion requerida: contactar al cliente a la brevedad"].join("\n") }); console.log("Internal notification sent for IVR request"); return true; } catch (error) { console.error(`Internal notification failed for IVR request: ${formatMailError(error)}`); return false; } }
async function sendCustomerConfirmation(transporter, cita, fromEmail) { try { await transporter.sendMail({ from: fromEmail, to: cita.correo, subject: `Confirmacion de cita ${cita.folio}`, text: customerEmailText(cita) }); console.log(`Email confirmation sent for ${cita.folio}`); return true; } catch (error) { console.error(`Email confirmation failed for ${cita.folio}: ${formatMailError(error)}`); return false; } }
async function sendInternalNotification(transporter, cita, fromEmail) { if (!process.env.INTERNAL_NOTIFY_EMAIL) return false; try { await transporter.sendMail({ from: fromEmail, to: process.env.INTERNAL_NOTIFY_EMAIL, subject: `Nueva cita inmobiliaria ${cita.folio}`, text: internalEmailText(cita) }); console.log(`Internal notification sent for ${cita.folio}`); return true; } catch (error) { console.error(`Internal notification failed for ${cita.folio}: ${formatMailError(error)}`); return false; } }
function customerEmailText(cita) { return [`Nombre: ${cita.nombre}`, `Folio: ${cita.folio}`, `Propiedad: ${cita.propiedad || "Por confirmar"}`, cita.ubicacion ? `Ubicacion: ${cita.ubicacion}` : "", `Tipo de cita: ${cita.tipo}`, `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, "", "Conserva tu folio para cualquier cambio o seguimiento de tu visita.", "", "Gracias por contactar a Inmobiliaria Carvalho."].filter(Boolean).join("\n"); }
function internalEmailText(cita) { return [`Folio: ${cita.folio}`, `Nombre del cliente: ${cita.nombre}`, `Telefono: ${cita.telefono}`, `Correo: ${cita.correo}`, `Tipo de cita: ${cita.tipo}`, `Propiedad: ${cita.propiedad || "Por confirmar"}`, cita.ubicacion ? `Ubicacion: ${cita.ubicacion}` : "", `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, `Comentarios: ${cita.comentarios || "Sin comentarios"}`, `Estatus: ${cita.estatus}`, `Fecha de creacion: ${cita.createdAt}`, cita.calendarEventId ? `Google Calendar event: ${cita.calendarEventId}` : ""].filter(Boolean).join("\n"); }
