const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const BRAND_NAME = "Inmobiliaria Sicilia";
const BRAND_SHORT = "Sicilia";
const citas = [];
const solicitudesIvr = [];
let folioCounter = 1;
let dbPool;
let dbReady = false;

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
app.get(["/", "/index.html"], (req, res) => serveBrandedHtml(res, "index.html"));
app.get("/admin.html", (req, res) => serveBrandedHtml(res, "admin.html"));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.type("text/plain").send("ok"));

app.post("/api/validate-folio", async (req, res) => {
  const normalizedFolio = normalizeValidationFolio(req.body.folio);

  if (!normalizedFolio) {
    return res.json({
      ok: false,
      found: false,
      message: "Folio requerido"
    });
  }

  if (!dbPool) {
    return res.status(503).json({
      ok: false,
      found: false,
      searchedFolio: normalizedFolio,
      message: "Base de datos no disponible"
    });
  }

  try {
    const result = await dbPool.query(
      "select id, folio, nombre, telefono, correo from appointments where lower(folio) = lower($1) limit 1",
      [normalizedFolio]
    );

    if (!result.rows[0]) {
      return res.json({
        ok: true,
        found: false,
        searchedFolio: normalizedFolio,
        message: "Folio no encontrado"
      });
    }

    const appointment = result.rows[0];

    return res.json({
      ok: true,
      found: true,
      id: appointment.id,
      folio: appointment.folio,
      nombre: appointment.nombre,
      telefono: appointment.telefono,
      correo: appointment.correo,
      message: "Folio encontrado"
    });
  } catch (error) {
    console.error("No se pudo validar el folio:", error.message);
    return res.status(500).json({
      ok: false,
      found: false,
      searchedFolio: normalizedFolio,
      message: "No fue posible validar el folio"
    });
  }
});

app.get("/api/citas", async (req, res) => {
  const q = clean(req.query.q).toLowerCase();
  const rows = await listAppointments();
  const filtered = q ? rows.filter((cita) => [cita.folio, cita.nombre, cita.telefono, cita.correo].filter(Boolean).some((value) => String(value).toLowerCase().includes(q))) : rows;
  res.json(filtered);
});

app.get("/api/citas/:folio", async (req, res) => {
  const cita = await findCita(req.params.folio);
  if (!cita) return res.status(404).json({ error: "Cita no encontrada" });
  res.json(cita);
});

app.post("/api/citas", async (req, res) => {
  const { nombre, telefono, correo, tipo, fecha, hora } = req.body;
  const propiedad = resolvePropertyFromPayload(req.body);
  if (!nombre || !telefono || !correo || !tipo || !fecha || !hora || !propiedad) return res.status(400).json({ error: "nombre, telefono, correo, propiedad, tipo, fecha y hora son obligatorios" });
  try {
    const cita = await createConfirmedAppointment({ ...req.body, propiedad, tipo, origen: "Formulario" });
    res.status(201).json(toCreateResponse(cita));
  } catch (error) {
    handleCalendarCreateError(res, error);
  }
});

app.patch("/api/citas/:folio", async (req, res) => {
  const cita = await findCita(req.params.folio);
  if (!cita) return res.status(404).json({ error: "Cita no encontrada" });
  ["fecha", "hora", "estatus", "tipo", "comentarios"].forEach((field) => { if (Object.prototype.hasOwnProperty.call(req.body, field)) cita[field] = clean(req.body[field]); });
  if (Object.prototype.hasOwnProperty.call(req.body, "propiedad")) { cita.propiedad = normalizePropertyName(req.body.propiedad); cita.ubicacion = getPropertyLocation(req.body.propiedad); }
  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);
  await saveAppointment(cita);
  res.json(cita);
});

app.patch("/api/citas/:folio/cancelar", async (req, res) => {
  const cita = await findCita(req.params.folio);
  if (!cita) return res.status(404).json({ error: "Cita no encontrada" });
  const result = await cancelAppointment(cita);
  if (!result.ok) return res.status(503).json(result);
  res.json(result);
});

app.get("/api/ivr/citas/:folio", async (req, res) => { const cita = await findCita(req.params.folio); res.json(cita ? toIvrCitaResponse(cita) : ivrNotFound()); });
app.patch("/api/ivr/citas/:folio/cancelar", async (req, res) => {
  const cita = await findCita(req.params.folio);
  if (!cita) return res.json(ivrNotFound());
  const result = await cancelAppointment(cita);
  if (!result.ok) return res.status(503).json(result);
  res.json({ ...result, found: true, action: "cancelar", message: "Tu cita fue cancelada correctamente." });
});
app.patch("/api/ivr/citas/:folio/confirmar", async (req, res) => updateIvrStatus(req, res, "Confirmada", "confirmar", "Tu asistencia fue confirmada correctamente."));
app.patch("/api/ivr/citas/:folio/reagendar", async (req, res) => rescheduleIvr(req, res, await findCita(req.params.folio), { folio: true }));

app.get("/api/ivr/clientes/:telefono/cita", async (req, res) => { const cita = await findLatestCitaByTelefono(req.params.telefono); res.json(cita ? toPhoneIvrCitaResponse(cita, req.params.telefono) : phoneIvrNotFound()); });
app.patch("/api/ivr/clientes/:telefono/cita/confirmar", async (req, res) => {
  const cita = await findLatestCitaByTelefono(req.params.telefono);
  if (!cita) return res.json(phoneIvrNotFound());
  cita.estatus = "Confirmada"; cita.updatedAt = new Date().toISOString(); cita.whatsappUrl = buildWhatsAppUrl(cita);
  const emailResult = await sendIvrActionEmails(cita, "confirmar", "Tu cita fue confirmada correctamente.");
  cita.emailSent = emailResult.emailSent; cita.internalEmailSent = emailResult.internalEmailSent;
  await saveAppointment(cita);
  res.json({ ok: true, found: true, action: "confirmar", telefono: clean(req.params.telefono), folio: cita.folio, estatus: cita.estatus, message: "Tu cita fue confirmada correctamente." });
});
app.patch("/api/ivr/clientes/:telefono/cita/cancelar", async (req, res) => {
  const cita = await findLatestCitaByTelefono(req.params.telefono);
  if (!cita) return res.json(phoneIvrNotFound());
  const result = await cancelAppointment(cita);
  if (!result.ok) return res.status(503).json(result);
  res.json({ ...result, found: true, action: "cancelar", telefono: clean(req.params.telefono), message: "Tu cita fue cancelada correctamente." });
});
app.patch("/api/ivr/clientes/:telefono/cita/reagendar", async (req, res) => rescheduleIvr(req, res, await findLatestCitaByTelefono(req.params.telefono), { telefono: clean(req.params.telefono) }));
app.get("/api/ivr/propiedades/horarios", (req, res) => res.json({ ok: true, propiedades: getIvrPropertySchedules() }));

app.get("/api/calendar/availability", async (req, res) => {
  try { res.json(await getCalendarAvailability(clean(req.query.fecha) || todayInCalendarTimezone())); }
  catch (error) { console.error("Disponibilidad de Calendar no disponible:", error.message); res.status(503).json({ ok: false, message: "Disponibilidad temporalmente no disponible." }); }
});

app.post("/api/calendar/book", async (req, res) => {
  const nombre = clean(req.body.nombre), telefono = clean(req.body.telefono), correo = clean(req.body.correo), propiedad = normalizePropertyName(req.body.propiedad), fecha = clean(req.body.fecha), hora = clean(req.body.hora);
  if (!nombre || !telefono || !correo || !propiedad || !fecha || !hora) return res.status(400).json({ error: "nombre, telefono, correo, propiedad, fecha y hora son obligatorios" });
  try {
    const cita = await createConfirmedAppointment({ ...req.body, propiedad, tipo: clean(req.body.tipo) || "Visita a propiedad", comentarios: appendPropertyToComments(req.body.comentarios, propiedad), origen: "Calendario en vivo" });
    res.status(201).json(toCreateResponse(cita));
  } catch (error) { handleCalendarCreateError(res, error); }
});

app.post("/api/ivr/solicitudes", async (req, res) => {
  const telefono = clean(req.body.telefono);
  if (!telefono) return res.status(400).json({ ok: false, error: "telefono es obligatorio" });
  const solicitud = { telefono, propiedad: normalizePropertyInterest(req.body.propiedad), origen: clean(req.body.origen) || "GoTo IVR", createdAt: new Date().toISOString() };
  solicitudesIvr.push(solicitud);
  await sendIvrContactRequestEmail(solicitud);
  res.json({ ok: true, action: "solicitud_contacto", message: `Hemos registrado tu solicitud. Un asesor de ${BRAND_NAME} se pondra en contacto contigo a la brevedad.` });
});

app.listen(PORT, () => console.log(`Citas GoTo demo escuchando en puerto ${PORT}`));

function isDbEnabled() { return Boolean(process.env.DATABASE_URL); }
function getDbPool() { if (!isDbEnabled()) return null; if (!dbPool) { dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false } }); console.log("DATABASE_URL configured, using PostgreSQL storage"); } return dbPool; }
async function initDbIfNeeded() { if (!getDbPool() || dbReady) return; await getDbPool().query("select 1"); dbReady = true; }
async function withDb(operation) { if (!isDbEnabled()) { console.log("DATABASE_URL not configured, using in-memory storage"); return null; } try { await initDbIfNeeded(); return await operation(getDbPool()); } catch (error) { console.error("PostgreSQL unavailable, using in-memory fallback"); return null; } }
async function nextFolio() { const dbFolio = await withDb(async (pool) => { const result = await pool.query("insert into folio_counters (prefix, last_number, updated_at) values ($1, 1, now()) on conflict (prefix) do update set last_number = folio_counters.last_number + 1, updated_at = now() returning last_number", ["SIC"]); return `SIC-${String(result.rows[0].last_number).padStart(6, "0")}`; }); if (dbFolio) return dbFolio; const value = String(folioCounter).padStart(6, "0"); folioCounter += 1; return `SIC-${value}`; }
function clean(value) { return String(value || "").trim(); }
function normalizeValidationFolio(value) { const raw = clean(value).toUpperCase(); if (!raw) return ""; const numericPart = raw.replace(/^SIC-?/, "").replace(/\D/g, ""); return numericPart ? `SIC-${numericPart.padStart(6, "0")}` : ""; }
function normalizePhone(value) { return String(value || "").replace(/\D/g, ""); }
function comparablePhone(value) { const phone = normalizePhone(value); return phone.length > 10 ? phone.slice(-10) : phone; }
function phonesMatch(left, right) { const l = normalizePhone(left); const r = normalizePhone(right); return Boolean(l && r && (l === r || comparablePhone(l) === comparablePhone(r))); }
function normalizeTextKey(value) { return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function findPropertyDetails(value) { const key = normalizeTextKey(value); return PROPERTY_DETAILS.find((property) => normalizeTextKey(property.nombre) === key || normalizeTextKey(property.nombreVisible) === key); }
function normalizePropertyName(value) { const property = findPropertyDetails(value); return property ? property.nombreVisible || property.nombre : clean(value); }
function getPropertyLocation(value) { const property = findPropertyDetails(value); return property ? property.ubicacionVisible || property.ubicacion : ""; }
function resolvePropertyFromPayload(payload) { const direct = normalizePropertyName(payload.propiedad); if (direct) return direct; const match = clean(payload.comentarios).match(/Propiedad(?: seleccionada)?:\s*([^\n]+)/i); return match ? normalizePropertyName(match[1]) : "Departamento en Polanco"; }
function toDbRow(cita) { return [cita.folio, cita.nombre, cita.telefono, cita.correo, cita.tipo, cita.propiedad, cita.ubicacion, cita.fecha, cita.hora, cita.comentarios, cita.estatus, cita.origen || "web", cita.calendarEventId || "", Boolean(cita.emailSent), Boolean(cita.internalEmailSent), false, cita.whatsappUrl || ""]; }
function fromDbRow(row) { return { folio: row.folio, nombre: row.nombre, telefono: row.telefono, correo: row.correo, tipo: row.necesidad || "", necesidad: row.necesidad || "", propiedad: row.propiedad || "", ubicacion: row.ubicacion || "", fecha: row.fecha, hora: row.hora, comentarios: row.comentarios || "", estatus: row.estatus || "Pendiente", origen: row.origen || "web", calendarEventId: row.calendar_event_id || "", emailSent: Boolean(row.email_sent), internalEmailSent: Boolean(row.internal_email_sent), whatsappSent: Boolean(row.whatsapp_sent), whatsappUrl: row.whatsapp_url || "", createdAt: row.created_at, updatedAt: row.updated_at }; }
async function listAppointments() { const dbRows = await withDb(async (pool) => (await pool.query("select * from appointments order by created_at desc")).rows.map(fromDbRow)); return dbRows || citas; }
async function findCita(folio) { const key = clean(folio).toLowerCase(); const dbCita = await withDb(async (pool) => { const result = await pool.query("select * from appointments where lower(folio) = $1 limit 1", [key]); return result.rows[0] ? fromDbRow(result.rows[0]) : null; }); if (dbCita) return dbCita; return citas.find((cita) => cita.folio.toLowerCase() === key) || null; }
async function saveAppointment(cita) { const saved = await withDb(async (pool) => { await pool.query("insert into appointments (folio,nombre,telefono,correo,necesidad,propiedad,ubicacion,fecha,hora,comentarios,estatus,origen,calendar_event_id,email_sent,internal_email_sent,whatsapp_sent,whatsapp_url,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,coalesce($18,now()),now()) on conflict (folio) do update set nombre=excluded.nombre, telefono=excluded.telefono, correo=excluded.correo, necesidad=excluded.necesidad, propiedad=excluded.propiedad, ubicacion=excluded.ubicacion, fecha=excluded.fecha, hora=excluded.hora, comentarios=excluded.comentarios, estatus=excluded.estatus, origen=excluded.origen, calendar_event_id=excluded.calendar_event_id, email_sent=excluded.email_sent, internal_email_sent=excluded.internal_email_sent, whatsapp_sent=excluded.whatsapp_sent, whatsapp_url=excluded.whatsapp_url, updated_at=now()", [...toDbRow(cita), cita.createdAt || null]); console.log(`Appointment saved to PostgreSQL ${cita.folio}`); return true; }); if (saved) return cita; const index = citas.findIndex((item) => item.folio.toLowerCase() === cita.folio.toLowerCase()); if (index >= 0) citas[index] = cita; else citas.push(cita); console.log(`Appointment saved in memory ${cita.folio}`); return cita; }
async function findLatestCitaByTelefono(telefono) { return (await listAppointments()).filter((cita) => phonesMatch(cita.telefono, telefono)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null; }
function ivrNotFound() { return { ok: true, found: false, message: "No encontramos una cita con ese folio." }; }
function phoneIvrNotFound() { return { ok: true, found: false, message: "No encontramos una cita asociada a ese numero telefonico." }; }
function toIvrCitaResponse(cita) { return { ok: true, found: true, folio: cita.folio, nombre: cita.nombre, telefono: cita.telefono, correo: cita.correo, tipo: cita.tipo, fecha: cita.fecha, hora: cita.hora, estatus: cita.estatus }; }
function toPhoneIvrCitaResponse(cita, telefono) { return { ok: true, found: true, telefono: clean(telefono), folio: cita.folio, nombre: cita.nombre, correo: cita.correo, tipo: cita.tipo, fecha: cita.fecha, hora: cita.hora, estatus: cita.estatus }; }
async function createConfirmedAppointment(payload) { const propiedad = resolvePropertyFromPayload(payload); const fecha = clean(payload.fecha); const hora = clean(payload.hora); const availability = await getCalendarAvailability(fecha); if (!isSlotAvailable(availability, propiedad, hora)) { const error = new Error("Ese horario acaba de ocuparse. Por favor selecciona otro horario disponible."); error.statusCode = 409; throw error; } const folio = clean(payload.folio) || await nextFolio(); const base = buildAppointment({ ...payload, folio, propiedad, estatus: "Confirmada" }); const calendarEventId = await createCalendarEvent(base, propiedad); if (!calendarEventId) { const error = new Error("No se pudo crear el evento en Google Calendar. Intenta de nuevo."); error.calendarRequired = true; throw error; } return createAppointment({ ...payload, folio, propiedad, calendarEventId, estatus: "Confirmada" }); }
function buildAppointment(payload) { const propiedad = resolvePropertyFromPayload(payload); return { folio: clean(payload.folio), nombre: clean(payload.nombre), telefono: clean(payload.telefono), correo: clean(payload.correo), tipo: clean(payload.tipo), necesidad: clean(payload.tipo), propiedad, ubicacion: getPropertyLocation(propiedad), fecha: clean(payload.fecha), hora: clean(payload.hora), comentarios: clean(payload.comentarios), estatus: clean(payload.estatus) || "Confirmada", origen: clean(payload.origen) || "web", calendarEventId: clean(payload.calendarEventId), whatsappUrl: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }
async function createAppointment(payload) { const cita = buildAppointment({ ...payload, folio: clean(payload.folio) || await nextFolio() }); if (cita.estatus === "Confirmada" && !cita.calendarEventId) { const error = new Error("Confirmed appointment requires calendarEventId"); error.calendarRequired = true; throw error; } cita.whatsappUrl = buildWhatsAppUrl(cita); await saveAppointment(cita); const emailResult = await sendAppointmentEmails(cita); cita.emailSent = emailResult.emailSent; cita.internalEmailSent = emailResult.internalEmailSent; await saveAppointment(cita); return cita; }
function toCreateResponse(cita) { return { ok: true, folio: cita.folio, estatus: cita.estatus, calendarEventId: cita.calendarEventId, emailSent: Boolean(cita.emailSent), internalEmailSent: Boolean(cita.internalEmailSent), whatsappUrl: cita.whatsappUrl, fecha: cita.fecha, hora: cita.hora, propiedad: cita.propiedad, tipo: cita.tipo }; }
function handleCalendarCreateError(res, error) { if (error.statusCode === 409) return res.status(409).json({ ok: false, error: error.message }); console.error("No se pudo confirmar Google Calendar:", error.message); return res.status(503).json({ ok: false, message: "No fue posible confirmar el horario en Google Calendar. Intenta nuevamente o solicita apoyo de un asesor." }); }
async function updateIvrStatus(req, res, estatus, action, message) { const cita = await findCita(req.params.folio); if (!cita) return res.json(ivrNotFound()); cita.estatus = estatus; cita.updatedAt = new Date().toISOString(); cita.whatsappUrl = buildWhatsAppUrl(cita); const emailResult = await sendIvrActionEmails(cita, action, message); cita.emailSent = emailResult.emailSent; cita.internalEmailSent = emailResult.internalEmailSent; await saveAppointment(cita); res.json({ ok: true, found: true, action, folio: cita.folio, estatus: cita.estatus, message }); }
async function rescheduleIvr(req, res, cita, context) { const fecha = clean(req.body.fecha); const hora = clean(req.body.hora); if (!cita) return res.json(context.folio ? ivrNotFound() : phoneIvrNotFound()); if (!fecha || !hora) return res.status(400).json({ ok: false, error: "fecha y hora son obligatorias" }); cita.fecha = fecha; cita.hora = hora; cita.estatus = "Reagendada"; cita.updatedAt = new Date().toISOString(); cita.whatsappUrl = buildWhatsAppUrl(cita); const emailResult = await sendIvrActionEmails(cita, "reagendar", "Tu cita fue reagendada correctamente."); cita.emailSent = emailResult.emailSent; cita.internalEmailSent = emailResult.internalEmailSent; await saveAppointment(cita); res.json({ ok: true, found: true, action: "reagendar", telefono: context.telefono, folio: cita.folio, fecha: cita.fecha, hora: cita.hora, estatus: cita.estatus, message: "Tu cita fue reagendada correctamente." }); }
function getIvrPropertySchedules() { return PROPERTY_DETAILS.map((property) => ({ id: property.id, nombre: property.nombreVisible || property.nombre, ubicacion: property.ubicacionVisible || property.ubicacion, tipo: property.tipo, disponible: Boolean(property.horario), horarios: property.horario ? [property.horario] : [], message: property.horario ? undefined : "Agenda llena" })); }
function normalizePropertyInterest(value) { const map = { 1: "Departamento en Polanco", 2: "Casa en Coyoacán", 3: "Oficina en Santa Fe", 4: "Penthouse en Interlomas" }; const propiedad = clean(value); return normalizePropertyName(map[propiedad] || propiedad || "No especificada"); }
function todayInCalendarTimezone() { return new Intl.DateTimeFormat("en-CA", { timeZone: CALENDAR_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function appendPropertyToComments(comentarios, propiedad) { const base = clean(comentarios); const line = `Propiedad: ${propiedad}`; return base.includes(line) ? base : base ? `${line}\n${base}` : line; }
async function getCalendarAvailability(fecha) { ensureCalendarConfig(); const events = await fetchCalendarEvents(fecha); const properties = CALENDAR_PROPERTIES.map((nombre) => { const detail = findPropertyDetails(nombre); const slots = BASE_HOURS.map((hora) => buildAvailabilitySlot(fecha, hora, events)); return { nombre, ubicacion: detail ? detail.ubicacionVisible || detail.ubicacion : "", tipo: detail ? detail.tipo : "", agendaLlena: slots.every((slot) => slot.status !== "disponible"), slots }; }); return { ok: true, fecha, timezone: CALENDAR_TIMEZONE, properties }; }
function buildAvailabilitySlot(fecha, hora, events) { const start = slotDate(fecha, hora); const end = addMinutes(start, APPOINTMENT_MINUTES); return events.some((event) => rangesOverlap(start, end, event.start, event.end)) ? { hora, status: "ocupado", label: "Ocupado", available: false } : { hora, status: "disponible", label: "Disponible", available: true }; }
function isSlotAvailable(availability, propiedad, hora) { const property = availability.properties.find((item) => normalizeTextKey(item.nombre) === normalizeTextKey(propiedad)); const slot = property && property.slots.find((item) => item.hora === hora); return Boolean(slot && slot.available); }
async function fetchCalendarEvents(fecha) { const token = await getGoogleAccessToken(); const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID); const params = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin: `${fecha}T00:00:00-06:00`, timeMax: `${fecha}T23:59:59-06:00` }); const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error(`Google Calendar respondio ${response.status}`); const data = await response.json(); return (data.items || []).filter((event) => event.status !== "cancelled" && event.start && event.end && event.start.dateTime && event.end.dateTime).map((event) => ({ id: event.id, summary: event.summary || "", description: event.description || "", extendedProperties: event.extendedProperties || {}, start: new Date(event.start.dateTime), end: new Date(event.end.dateTime) })); }
async function createCalendarEvent(cita, propiedad) { ensureCalendarConfig(); const token = await getGoogleAccessToken(); const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID); const startDate = slotDate(cita.fecha, cita.hora); const endDate = addMinutes(startDate, APPOINTMENT_MINUTES); const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ summary: `Visita Sicilia - ${propiedad}`, description: [`Folio: ${cita.folio}`, `Nombre: ${cita.nombre}`, `Telefono: ${cita.telefono}`, `Correo: ${cita.correo}`, `Propiedad: ${propiedad}`, `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, cita.comentarios ? `Comentarios: ${cita.comentarios}` : ""].filter(Boolean).join("\n"), start: { dateTime: toCalendarDateTime(startDate), timeZone: CALENDAR_TIMEZONE }, end: { dateTime: toCalendarDateTime(endDate), timeZone: CALENDAR_TIMEZONE }, extendedProperties: { private: { folio: cita.folio, source: "sicilia", telefono: cita.telefono, correo: cita.correo, propiedad } } }) }); if (!response.ok) throw new Error(`Google Calendar no creo el evento: ${response.status}`); const data = await response.json(); console.log(`Calendar event created for ${cita.folio}`); return data.id; }
async function cancelAppointment(cita) { const calendarResult = await cancelCalendarEventForAppointment(cita); if (calendarResult.calendarBlockingError) return { ok: false, folio: cita.folio, estatus: cita.estatus, calendarReleased: false, message: "No fue posible liberar Google Calendar. La cita no se marcó como cancelada." }; cita.estatus = "Cancelada"; cita.updatedAt = new Date().toISOString(); cita.whatsappUrl = buildWhatsAppUrl(cita); const cancellationEmailSent = await sendCancellationCustomerEmail(cita); const internalCancellationEmailSent = await sendCancellationInternalEmail(cita, calendarResult); await saveAppointment(cita); console.log(`Appointment status updated ${cita.folio}`); return { ok: true, folio: cita.folio, estatus: cita.estatus, calendarReleased: calendarResult.calendarReleased, cancellationEmailSent, internalCancellationEmailSent }; }
async function cancelCalendarEventForAppointment(cita) { try { ensureCalendarConfig(); } catch { return { calendarReleased: false, calendarBlockingError: true, calendarMessage: "Google Calendar no configurado." }; } try { const eventId = cita.calendarEventId || await findCalendarEventForAppointment(cita); if (!eventId) { console.log("Calendar event not found or ambiguous for cancelled appointment"); return { calendarReleased: false, calendarBlockingError: false, calendarMessage: "Calendar event not found or ambiguous for cancelled appointment" }; } await deleteCalendarEvent(eventId); cita.calendarEventId = ""; console.log(`Calendar event cancelled for ${cita.folio}`); return { calendarReleased: true, calendarBlockingError: false }; } catch (error) { console.error(`Calendar event cancellation failed for ${cita.folio}: ${error.message}`); return { calendarReleased: false, calendarBlockingError: true, calendarMessage: "No se pudo liberar Google Calendar." }; } }
async function findCalendarEventForAppointment(cita) { const events = await fetchCalendarEvents(cita.fecha); const slot = slotDate(cita.fecha, cita.hora); const matches = events.filter((event) => { const text = `${event.summary}\n${event.description}\n${JSON.stringify(event.extendedProperties)}`; const sameTime = Math.abs(event.start.getTime() - slot.getTime()) < 60000; const hasFolio = cita.folio && text.includes(cita.folio); const hasCorreo = cita.correo && text.toLowerCase().includes(cita.correo.toLowerCase()); const hasTelefono = cita.telefono && normalizePhone(text).includes(comparablePhone(cita.telefono)); const hasProperty = cita.propiedad && normalizeTextKey(text).includes(normalizeTextKey(cita.propiedad)); return sameTime && (hasFolio || (hasCorreo && hasTelefono && hasProperty)); }); return matches.length === 1 ? matches[0].id : ""; }
async function deleteCalendarEvent(eventId) { const token = await getGoogleAccessToken(); const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID); const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error(`Google Calendar respondio ${response.status}`); }
function ensureCalendarConfig() { if (!process.env.GOOGLE_CALENDAR_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) throw new Error("Google Calendar no configurado"); }
async function getGoogleAccessToken() { const now = Math.floor(Date.now() / 1000); const header = { alg: "RS256", typ: "JWT" }; const payload = { iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }; const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`; const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"); const signature = crypto.createSign("RSA-SHA256").update(unsignedToken).sign(privateKey); const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsignedToken}.${base64Url(signature)}` }) }); if (!response.ok) throw new Error(`Google OAuth respondio ${response.status}`); return (await response.json()).access_token; }
function base64Url(value) { const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value); return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function slotDate(fecha, hora) { return new Date(`${fecha}T${hora}:00-06:00`); }
function addMinutes(date, minutes) { return new Date(date.getTime() + minutes * 60000); }
function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) { return leftStart < rightEnd && leftEnd > rightStart; }
function toCalendarDateTime(date) { const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: CALENDAR_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date).map((part) => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`; }
function createSmtpTransporter() { const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env; if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !process.env.FROM_EMAIL) return null; return nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT), secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || Number(SMTP_PORT) === 465, connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 45000, auth: { user: SMTP_USER, pass: SMTP_PASS } }); }
function buildWhatsAppUrl(cita) { const phone = cita.telefono.replace(/[^\d]/g, ""); const message = [`Hola, ${cita.nombre}. Tu cita con ${BRAND_NAME} fue registrada correctamente.`, "", `Folio: ${cita.folio}`, cita.propiedad ? `Propiedad: ${cita.propiedad}` : "", cita.ubicacion ? `Ubicacion: ${cita.ubicacion}` : "", `Tipo de cita: ${cita.tipo}`, `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, "", "Para cambios o seguimiento, conserva tu folio y contacta a un asesor."].filter(Boolean).join("\n"); return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`; }
async function sendAppointmentEmails(cita) { if (process.env.RESEND_API_KEY) return sendAppointmentEmailsWithResend(cita); const transporter = createSmtpTransporter(); if (!transporter) { console.log(`Correo omitido para ${cita.folio}: variables SMTP incompletas.`); return { emailSent: false, internalEmailSent: false }; } const emailSent = await sendCustomerConfirmation(transporter, cita, process.env.FROM_EMAIL); const internalEmailSent = await sendInternalNotification(transporter, cita, process.env.FROM_EMAIL); return { emailSent, internalEmailSent }; }
async function sendAppointmentEmailsWithResend(cita) { if (!process.env.FROM_EMAIL) return { emailSent: false, internalEmailSent: false }; const emailSent = await sendResendEmail({ to: cita.correo, subject: `Confirmacion de cita ${cita.folio} - ${BRAND_NAME}`, text: customerEmailText(cita), logOk: `Email confirmation sent for ${cita.folio}`, logFail: `Email confirmation failed for ${cita.folio}` }); const internalEmailSent = process.env.INTERNAL_NOTIFY_EMAIL ? await sendResendEmail({ to: process.env.INTERNAL_NOTIFY_EMAIL, subject: `Nueva cita ${BRAND_NAME} ${cita.folio}`, text: internalEmailText(cita), logOk: `Internal notification sent for ${cita.folio}`, logFail: `Internal notification failed for ${cita.folio}` }) : false; return { emailSent, internalEmailSent }; }
async function sendResendEmail({ to, subject, text, logOk, logFail }) { try { const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: process.env.FROM_EMAIL, to, subject, text }) }); if (!response.ok) throw new Error(`Resend respondio ${response.status}`); console.log(logOk); return true; } catch (error) { console.error(`${logFail}: ${formatMailError(error)}`); return false; } }
function formatMailError(error) { const message = String(error && error.message || error || ""); return /timeout|timed out|etimedout|esocket/i.test(message) ? "connection timeout" : message; }
async function sendIvrActionEmails(cita, action, message) { const transporter = createSmtpTransporter(); if (!transporter) { console.log(`Correo IVR omitido para ${cita.folio}: variables SMTP incompletas.`); return { emailSent: false, internalEmailSent: false }; } const emailSent = await sendIvrCustomerEmail(transporter, cita, process.env.FROM_EMAIL, action, message); const internalEmailSent = await sendIvrInternalEmail(transporter, cita, process.env.FROM_EMAIL, action, message); return { emailSent, internalEmailSent }; }
async function sendIvrCustomerEmail(transporter, cita, fromEmail, action, message) { if (!cita.correo) return false; try { await transporter.sendMail({ from: fromEmail, to: cita.correo, subject: `Actualizacion de cita ${cita.folio} - ${BRAND_NAME}`, text: [`Nombre: ${cita.nombre}`, `Folio: ${cita.folio}`, `Accion: ${action}`, `Estatus: ${cita.estatus}`, `Tipo de cita: ${cita.tipo}`, `Propiedad: ${cita.propiedad || "Por confirmar"}`, `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, "", message].filter(Boolean).join("\n") }); console.log(`Email confirmation sent for ${cita.folio}`); return true; } catch (error) { console.error(`Email confirmation failed for ${cita.folio}: ${formatMailError(error)}`); return false; } }
async function sendIvrInternalEmail(transporter, cita, fromEmail, action, message) { if (!process.env.INTERNAL_NOTIFY_EMAIL) return false; try { await transporter.sendMail({ from: fromEmail, to: process.env.INTERNAL_NOTIFY_EMAIL, subject: `Actualizacion de cita ${cita.folio} - ${BRAND_NAME}`, text: [`Folio: ${cita.folio}`, `Accion: ${action}`, `Mensaje: ${message}`, `Nombre del cliente: ${cita.nombre}`, `Telefono: ${cita.telefono}`, `Correo: ${cita.correo}`, `Tipo de cita: ${cita.tipo}`, `Propiedad: ${cita.propiedad || "Por confirmar"}`, `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, `Comentarios: ${cita.comentarios || "Sin comentarios"}`, `Estatus: ${cita.estatus}`, `Actualizado: ${cita.updatedAt}`].join("\n") }); console.log(`Internal notification sent for ${cita.folio}`); return true; } catch (error) { console.error(`Internal notification failed for ${cita.folio}: ${formatMailError(error)}`); return false; } }
async function sendIvrContactRequestEmail(solicitud) { if (!process.env.INTERNAL_NOTIFY_EMAIL) return false; const transporter = createSmtpTransporter(); if (!transporter) return false; try { await transporter.sendMail({ from: process.env.FROM_EMAIL, to: process.env.INTERNAL_NOTIFY_EMAIL, subject: `Nueva solicitud por IVR - ${BRAND_NAME}`, text: [`Telefono: ${solicitud.telefono}`, `Propiedad de interes: ${solicitud.propiedad}`, `Origen: ${solicitud.origen}`, `Fecha de solicitud: ${solicitud.createdAt}`, "Accion requerida: contactar al cliente a la brevedad"].join("\n") }); console.log("Internal notification sent for IVR request"); return true; } catch (error) { console.error(`Internal notification failed for IVR request: ${formatMailError(error)}`); return false; } }
async function sendCustomerConfirmation(transporter, cita, fromEmail) { try { await transporter.sendMail({ from: fromEmail, to: cita.correo, subject: `Confirmacion de cita ${cita.folio} - ${BRAND_NAME}`, text: customerEmailText(cita) }); console.log(`Email confirmation sent for ${cita.folio}`); return true; } catch (error) { console.error(`Email confirmation failed for ${cita.folio}: ${formatMailError(error)}`); return false; } }
async function sendInternalNotification(transporter, cita, fromEmail) { if (!process.env.INTERNAL_NOTIFY_EMAIL) return false; try { await transporter.sendMail({ from: fromEmail, to: process.env.INTERNAL_NOTIFY_EMAIL, subject: `Nueva cita ${BRAND_NAME} ${cita.folio}`, text: internalEmailText(cita) }); console.log(`Internal notification sent for ${cita.folio}`); return true; } catch (error) { console.error(`Internal notification failed for ${cita.folio}: ${formatMailError(error)}`); return false; } }
async function sendCancellationCustomerEmail(cita) { if (process.env.RESEND_API_KEY) return sendResendEmail({ to: cita.correo, subject: `Cita cancelada - ${BRAND_NAME} - ${cita.folio}`, text: cancellationCustomerEmailText(cita), logOk: `Cancellation email sent for ${cita.folio}`, logFail: `Cancellation email failed for ${cita.folio}` }); const transporter = createSmtpTransporter(); if (!transporter || !cita.correo) return false; try { await transporter.sendMail({ from: process.env.FROM_EMAIL, to: cita.correo, subject: `Cita cancelada - ${BRAND_NAME} - ${cita.folio}`, text: cancellationCustomerEmailText(cita) }); console.log(`Cancellation email sent for ${cita.folio}`); return true; } catch (error) { console.error(`Cancellation email failed for ${cita.folio}: ${formatMailError(error)}`); return false; } }
async function sendCancellationInternalEmail(cita, calendarResult) { if (process.env.RESEND_API_KEY && process.env.INTERNAL_NOTIFY_EMAIL) return sendResendEmail({ to: process.env.INTERNAL_NOTIFY_EMAIL, subject: `Cita cancelada - ${cita.folio} - ${BRAND_NAME}`, text: cancellationInternalEmailText(cita, calendarResult), logOk: `Internal cancellation notification sent for ${cita.folio}`, logFail: `Internal cancellation notification failed for ${cita.folio}` }); const transporter = createSmtpTransporter(); if (!transporter || !process.env.INTERNAL_NOTIFY_EMAIL) return false; try { await transporter.sendMail({ from: process.env.FROM_EMAIL, to: process.env.INTERNAL_NOTIFY_EMAIL, subject: `Cita cancelada - ${cita.folio} - ${BRAND_NAME}`, text: cancellationInternalEmailText(cita, calendarResult) }); console.log(`Internal cancellation notification sent for ${cita.folio}`); return true; } catch (error) { console.error(`Internal cancellation notification failed for ${cita.folio}: ${formatMailError(error)}`); return false; } }
function customerEmailText(cita) { return [`Nombre: ${cita.nombre}`, `Folio: ${cita.folio}`, `Propiedad: ${cita.propiedad || "Por confirmar"}`, cita.ubicacion ? `Ubicacion: ${cita.ubicacion}` : "", `Tipo de cita: ${cita.tipo}`, `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, "", "Conserva tu folio para cualquier cambio o seguimiento de tu visita.", "", `Gracias por contactar a ${BRAND_NAME}.`].filter(Boolean).join("\n"); }
function internalEmailText(cita) { return [`Folio: ${cita.folio}`, `Nombre del cliente: ${cita.nombre}`, `Telefono: ${cita.telefono}`, `Correo: ${cita.correo}`, `Tipo de cita: ${cita.tipo}`, `Propiedad: ${cita.propiedad || "Por confirmar"}`, cita.ubicacion ? `Ubicacion: ${cita.ubicacion}` : "", `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, `Comentarios: ${cita.comentarios || "Sin comentarios"}`, `Estatus: ${cita.estatus}`, `Fecha de creacion: ${cita.createdAt}`, cita.calendarEventId ? `Google Calendar event: ${cita.calendarEventId}` : "", `emailSent: ${Boolean(cita.emailSent)}`, `internalEmailSent: ${Boolean(cita.internalEmailSent)}`].filter(Boolean).join("\n"); }
function cancellationCustomerEmailText(cita) { return [`Nombre: ${cita.nombre}`, `Folio: ${cita.folio}`, `Propiedad: ${cita.propiedad || "Por confirmar"}`, cita.ubicacion ? `Ubicacion: ${cita.ubicacion}` : "", `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, "Estatus: Cancelada", "", "Tu cita ha sido cancelada correctamente."].filter(Boolean).join("\n"); }
function cancellationInternalEmailText(cita, calendarResult) { return [`Folio: ${cita.folio}`, `Nombre del cliente: ${cita.nombre}`, `Telefono: ${cita.telefono}`, `Correo: ${cita.correo}`, `Propiedad: ${cita.propiedad || "Por confirmar"}`, cita.ubicacion ? `Ubicacion: ${cita.ubicacion}` : "", `Fecha: ${cita.fecha}`, `Hora: ${cita.hora}`, `Comentarios: ${cita.comentarios || "Sin comentarios"}`, `Origen: ${cita.origen || "web"}`, "Estatus: Cancelada", `Calendar event id: ${cita.calendarEventId || "No disponible"}`, `CalendarReleased: ${Boolean(calendarResult.calendarReleased)}`].filter(Boolean).join("\n"); }
function serveBrandedHtml(res, filename) { fs.readFile(path.join(__dirname, "public", filename), "utf8", (error, html) => { if (error) return res.status(500).send("No se pudo cargar la pagina."); res.type("html").send(applySiciliaBrand(html)); }); }
function applySiciliaBrand(html) { return html.replace(/Inmobiliaria Carvalho/g, BRAND_NAME).replace(/Panel asesor Carvalho/g, "Panel asesor Sicilia").replace(/Carvalho/g, BRAND_SHORT).replace(/CITA-100/g, "SIC-100").replace(/Visita Carvalho/g, "Visita Sicilia").replace(/IVR GoTo conectado a agenda externa/g, "agenda de visitas inmobiliarias"); }
