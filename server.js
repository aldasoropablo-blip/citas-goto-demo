const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// En esta demo las citas se guardan temporalmente en memoria.
// Para produccion debe usarse una base persistente como PostgreSQL, Google Sheets, Airtable o CRM.
const citas = [];
const solicitudesIvr = [];
let folioCounter = 1;

const CALENDAR_TIMEZONE = "America/Mexico_City";
const APPOINTMENT_MINUTES = 60;
const BUFFER_MINUTES = 60;
const BASE_HOURS = ["13:00", "15:00", "17:00"];
const CALENDAR_PROPERTIES = [
  "Departamento en Polanco",
  "Casa en Coyoacan",
  "Oficina en Santa Fe",
  "Penthouse en Interlomas"
];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => {
  res.type("text/plain").send("ok");
});

app.get("/api/citas", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();

  if (!q) {
    return res.json(citas);
  }

  const filtered = citas.filter((cita) => {
    return [cita.folio, cita.nombre, cita.telefono, cita.correo]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  res.json(filtered);
});

app.get("/api/citas/:folio", (req, res) => {
  const cita = findCita(req.params.folio);

  if (!cita) {
    return res.status(404).json({ error: "Cita no encontrada" });
  }

  res.json(cita);
});

app.post("/api/citas", async (req, res) => {
  const { nombre, telefono, correo, tipo, fecha, hora, comentarios } = req.body;

  if (!nombre || !telefono || !correo || !tipo || !fecha || !hora) {
    return res.status(400).json({
      error: "nombre, telefono, correo, tipo, fecha y hora son obligatorios"
    });
  }

  const cita = await createAppointment(req.body);

  res.status(201).json(cita);
});

app.patch("/api/citas/:folio", (req, res) => {
  const cita = findCita(req.params.folio);

  if (!cita) {
    return res.status(404).json({ error: "Cita no encontrada" });
  }

  const editableFields = ["fecha", "hora", "estatus", "tipo", "comentarios"];

  editableFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      cita[field] = clean(req.body[field]);
    }
  });

  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);

  res.json(cita);
});

app.patch("/api/citas/:folio/cancelar", (req, res) => {
  const cita = findCita(req.params.folio);

  if (!cita) {
    return res.status(404).json({ error: "Cita no encontrada" });
  }

  cita.estatus = "Cancelada";
  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);

  res.json(cita);
});

app.get("/api/ivr/citas/:folio", (req, res) => {
  const cita = findCita(req.params.folio);

  if (!cita) {
    return res.json(ivrNotFound());
  }

  res.json(toIvrCitaResponse(cita));
});

app.patch("/api/ivr/citas/:folio/cancelar", async (req, res) => {
  const cita = findCita(req.params.folio);

  if (!cita) {
    return res.json(ivrNotFound());
  }

  cita.estatus = "Cancelada";
  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);

  await sendIvrActionEmails(cita, "cancelar", "Tu cita fue cancelada correctamente.");

  res.json({
    ok: true,
    found: true,
    action: "cancelar",
    folio: cita.folio,
    estatus: cita.estatus,
    message: "Tu cita fue cancelada correctamente."
  });
});

app.patch("/api/ivr/citas/:folio/confirmar", async (req, res) => {
  const cita = findCita(req.params.folio);

  if (!cita) {
    return res.json(ivrNotFound());
  }

  cita.estatus = "Confirmada";
  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);

  await sendIvrActionEmails(cita, "confirmar", "Tu asistencia fue confirmada correctamente.");

  res.json({
    ok: true,
    found: true,
    action: "confirmar",
    folio: cita.folio,
    estatus: cita.estatus,
    message: "Tu asistencia fue confirmada correctamente."
  });
});

app.patch("/api/ivr/citas/:folio/reagendar", async (req, res) => {
  const cita = findCita(req.params.folio);
  const fecha = clean(req.body.fecha);
  const hora = clean(req.body.hora);

  if (!cita) {
    return res.json(ivrNotFound());
  }

  if (!fecha || !hora) {
    return res.status(400).json({
      ok: false,
      error: "fecha y hora son obligatorias"
    });
  }

  cita.fecha = fecha;
  cita.hora = hora;
  cita.estatus = "Reagendada";
  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);

  await sendIvrActionEmails(cita, "reagendar", "Tu cita fue reagendada correctamente.");

  res.json({
    ok: true,
    found: true,
    action: "reagendar",
    folio: cita.folio,
    fecha: cita.fecha,
    hora: cita.hora,
    estatus: cita.estatus,
    message: "Tu cita fue reagendada correctamente."
  });
});

app.get("/api/ivr/clientes/:telefono/cita", (req, res) => {
  const cita = findLatestCitaByTelefono(req.params.telefono);

  if (!cita) {
    return res.json(phoneIvrNotFound());
  }

  res.json(toPhoneIvrCitaResponse(cita, req.params.telefono));
});

app.patch("/api/ivr/clientes/:telefono/cita/confirmar", async (req, res) => {
  const cita = findLatestCitaByTelefono(req.params.telefono);

  if (!cita) {
    return res.json(phoneIvrNotFound());
  }

  cita.estatus = "Confirmada";
  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);

  await sendIvrActionEmails(cita, "confirmar", "Tu cita fue confirmada correctamente.");

  res.json({
    ok: true,
    found: true,
    action: "confirmar",
    telefono: clean(req.params.telefono),
    folio: cita.folio,
    estatus: cita.estatus,
    message: "Tu cita fue confirmada correctamente."
  });
});

app.patch("/api/ivr/clientes/:telefono/cita/cancelar", async (req, res) => {
  const cita = findLatestCitaByTelefono(req.params.telefono);

  if (!cita) {
    return res.json(phoneIvrNotFound());
  }

  cita.estatus = "Cancelada";
  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);

  await sendIvrActionEmails(cita, "cancelar", "Tu cita fue cancelada correctamente.");

  res.json({
    ok: true,
    found: true,
    action: "cancelar",
    telefono: clean(req.params.telefono),
    folio: cita.folio,
    estatus: cita.estatus,
    message: "Tu cita fue cancelada correctamente."
  });
});

app.patch("/api/ivr/clientes/:telefono/cita/reagendar", async (req, res) => {
  const cita = findLatestCitaByTelefono(req.params.telefono);
  const fecha = clean(req.body.fecha);
  const hora = clean(req.body.hora);

  if (!cita) {
    return res.json(phoneIvrNotFound());
  }

  if (!fecha || !hora) {
    return res.status(400).json({
      ok: false,
      error: "fecha y hora son obligatorias"
    });
  }

  cita.fecha = fecha;
  cita.hora = hora;
  cita.estatus = "Reagendada";
  cita.updatedAt = new Date().toISOString();
  cita.whatsappUrl = buildWhatsAppUrl(cita);

  await sendIvrActionEmails(cita, "reagendar", "Tu cita fue reagendada correctamente.");

  res.json({
    ok: true,
    found: true,
    action: "reagendar",
    telefono: clean(req.params.telefono),
    folio: cita.folio,
    fecha: cita.fecha,
    hora: cita.hora,
    estatus: cita.estatus,
    message: "Tu cita fue reagendada correctamente."
  });
});

app.get("/api/ivr/propiedades/horarios", (req, res) => {
  res.json({
    ok: true,
    propiedades: getIvrPropertySchedules()
  });
});

app.get("/api/calendar/availability", async (req, res) => {
  const fecha = clean(req.query.fecha) || todayInCalendarTimezone();

  try {
    const availability = await getCalendarAvailability(fecha);
    res.json(availability);
  } catch (error) {
    console.error("Disponibilidad de Calendar no disponible:", error.message);
    res.status(503).json({
      ok: false,
      message: "Disponibilidad temporalmente no disponible."
    });
  }
});

app.post("/api/calendar/book", async (req, res) => {
  const nombre = clean(req.body.nombre);
  const telefono = clean(req.body.telefono);
  const correo = clean(req.body.correo);
  const propiedad = clean(req.body.propiedad);
  const fecha = clean(req.body.fecha);
  const hora = clean(req.body.hora);

  if (!nombre || !telefono || !correo || !propiedad || !fecha || !hora) {
    return res.status(400).json({
      error: "nombre, telefono, correo, propiedad, fecha y hora son obligatorios"
    });
  }

  try {
    const availability = await getCalendarAvailability(fecha);

    if (!isSlotAvailable(availability, propiedad, hora)) {
      return res.status(409).json({
        error: "Ese horario acaba de ocuparse. Por favor selecciona otro horario disponible."
      });
    }

    await createCalendarEvent({
      nombre,
      telefono,
      correo,
      fecha,
      hora,
      comentarios: clean(req.body.comentarios)
    }, propiedad);

    const cita = await createAppointment({
      ...req.body,
      tipo: clean(req.body.tipo) || "Visita a propiedad",
      comentarios: appendPropertyToComments(req.body.comentarios, propiedad),
      propiedad
    });

    res.status(201).json(cita);
  } catch (error) {
    console.error("No se pudo reservar en Google Calendar:", error.message);
    res.status(503).json({
      ok: false,
      message: "Disponibilidad temporalmente no disponible."
    });
  }
});

app.post("/api/ivr/solicitudes", async (req, res) => {
  const telefono = clean(req.body.telefono);
  const propiedad = normalizePropertyInterest(req.body.propiedad);
  const origen = clean(req.body.origen) || "GoTo IVR";

  if (!telefono) {
    return res.status(400).json({
      ok: false,
      error: "telefono es obligatorio"
    });
  }

  const solicitud = {
    telefono,
    propiedad,
    origen,
    createdAt: new Date().toISOString()
  };

  solicitudesIvr.push(solicitud);
  await sendIvrContactRequestEmail(solicitud);

  res.json({
    ok: true,
    action: "solicitud_contacto",
    message: "Hemos registrado tu solicitud. Un asesor de Inmobiliaria Carvalho se pondra en contacto contigo a la brevedad."
  });
});

app.listen(PORT, () => {
  console.log(`Citas GoTo demo escuchando en puerto ${PORT}`);
});

function nextFolio() {
  const value = String(folioCounter).padStart(6, "0");
  folioCounter += 1;
  return `CITA-${value}`;
}

function clean(value) {
  return String(value || "").trim();
}

async function createAppointment(payload) {
  const cita = {
    // El folio se genera en esta app externa; no vive en GoTo.
    folio: nextFolio(),
    nombre: clean(payload.nombre),
    telefono: clean(payload.telefono),
    correo: clean(payload.correo),
    tipo: clean(payload.tipo),
    propiedad: clean(payload.propiedad),
    fecha: clean(payload.fecha),
    hora: clean(payload.hora),
    comentarios: clean(payload.comentarios),
    estatus: "Confirmada",
    whatsappUrl: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  cita.whatsappUrl = buildWhatsAppUrl(cita);
  citas.push(cita);
  cita.emailSent = await sendAppointmentEmails(cita);

  return cita;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function comparablePhone(value) {
  const phone = normalizePhone(value);
  return phone.length > 10 ? phone.slice(-10) : phone;
}

function phonesMatch(left, right) {
  const leftPhone = normalizePhone(left);
  const rightPhone = normalizePhone(right);

  if (!leftPhone || !rightPhone) {
    return false;
  }

  return leftPhone === rightPhone || comparablePhone(leftPhone) === comparablePhone(rightPhone);
}

function findCita(folio) {
  return citas.find((cita) => cita.folio.toLowerCase() === String(folio).toLowerCase());
}

function findLatestCitaByTelefono(telefono) {
  return citas
    .filter((cita) => phonesMatch(cita.telefono, telefono))
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0] || null;
}

function ivrNotFound() {
  return {
    ok: true,
    found: false,
    message: "No encontramos una cita con ese folio."
  };
}

function phoneIvrNotFound() {
  return {
    ok: true,
    found: false,
    message: "No encontramos una cita asociada a ese numero telefonico."
  };
}

function toIvrCitaResponse(cita) {
  return {
    ok: true,
    found: true,
    folio: cita.folio,
    nombre: cita.nombre,
    telefono: cita.telefono,
    correo: cita.correo,
    tipo: cita.tipo,
    fecha: cita.fecha,
    hora: cita.hora,
    estatus: cita.estatus
  };
}

function toPhoneIvrCitaResponse(cita, telefono) {
  return {
    ok: true,
    found: true,
    telefono: clean(telefono),
    folio: cita.folio,
    nombre: cita.nombre,
    correo: cita.correo,
    tipo: cita.tipo,
    fecha: cita.fecha,
    hora: cita.hora,
    estatus: cita.estatus
  };
}

function getIvrPropertySchedules() {
  return [
    {
      id: "1",
      nombre: "Departamento en Polanco",
      disponible: true,
      horarios: ["13:00"]
    },
    {
      id: "2",
      nombre: "Casa en Coyoacan",
      disponible: true,
      horarios: ["15:00"]
    },
    {
      id: "3",
      nombre: "Oficina en Santa Fe",
      disponible: true,
      horarios: ["17:00"]
    },
    {
      id: "4",
      nombre: "Penthouse en Interlomas",
      disponible: false,
      horarios: [],
      message: "Agenda llena"
    }
  ];
}

function normalizePropertyInterest(value) {
  const propiedad = clean(value);
  const propertyMap = {
    1: "Departamento en Polanco",
    2: "Casa en Coyoacan",
    3: "Oficina en Santa Fe",
    4: "Penthouse en Interlomas"
  };

  return propertyMap[propiedad] || propiedad || "No especificada";
}

function todayInCalendarTimezone() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CALENDAR_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function appendPropertyToComments(comentarios, propiedad) {
  const base = clean(comentarios);
  const propertyLine = `Propiedad: ${propiedad}`;
  return base ? `${propertyLine}\n${base}` : propertyLine;
}

async function getCalendarAvailability(fecha) {
  ensureCalendarConfig();

  const events = await fetchCalendarEvents(fecha);
  const properties = CALENDAR_PROPERTIES.map((nombre) => {
    const slots = BASE_HOURS.map((hora) => buildAvailabilitySlot(fecha, hora, events));
    const agendaLlena = slots.every((slot) => slot.status !== "disponible");

    return {
      nombre,
      agendaLlena,
      slots
    };
  });

  return {
    ok: true,
    fecha,
    timezone: CALENDAR_TIMEZONE,
    properties
  };
}

function buildAvailabilitySlot(fecha, hora, events) {
  const start = slotDate(fecha, hora);
  const end = addMinutes(start, APPOINTMENT_MINUTES);
  const occupied = events.some((event) => rangesOverlap(start, end, event.start, event.end));

  if (occupied) {
    return {
      hora,
      status: "ocupado",
      label: "Ocupado",
      available: false
    };
  }

  const blockedByBuffer = events.some((event) => {
    const beforeStart = addMinutes(event.start, -BUFFER_MINUTES);
    const afterEnd = addMinutes(event.end, BUFFER_MINUTES);
    return rangesOverlap(start, end, beforeStart, event.start) || rangesOverlap(start, end, event.end, afterEnd);
  });

  if (blockedByBuffer) {
    return {
      hora,
      status: "buffer",
      label: "No disponible",
      available: false
    };
  }

  return {
    hora,
    status: "disponible",
    label: "Disponible",
    available: true
  };
}

function isSlotAvailable(availability, propiedad, hora) {
  const property = availability.properties.find((item) => item.nombre.toLowerCase() === clean(propiedad).toLowerCase());
  const slot = property && property.slots.find((item) => item.hora === hora);
  return Boolean(slot && slot.available);
}

async function fetchCalendarEvents(fecha) {
  const token = await getGoogleAccessToken();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: `${fecha}T00:00:00-06:00`,
    timeMax: `${fecha}T23:59:59-06:00`
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Google Calendar respondio ${response.status}`);
  }

  const data = await response.json();
  return (data.items || [])
    .filter((event) => event.start && event.end && event.start.dateTime && event.end.dateTime)
    .map((event) => ({
      start: new Date(event.start.dateTime),
      end: new Date(event.end.dateTime)
    }));
}

async function createCalendarEvent(cita, propiedad) {
  ensureCalendarConfig();

  const token = await getGoogleAccessToken();
  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID);
  const startDate = slotDate(cita.fecha, cita.hora);
  const endDate = addMinutes(startDate, APPOINTMENT_MINUTES);
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      summary: `Visita Carvalho - ${propiedad}`,
      description: [
        `Nombre: ${cita.nombre}`,
        `Telefono: ${cita.telefono}`,
        `Correo: ${cita.correo}`,
        `Propiedad: ${propiedad}`,
        cita.comentarios ? `Comentarios: ${cita.comentarios}` : ""
      ].filter(Boolean).join("\n"),
      start: {
        dateTime: toCalendarDateTime(startDate),
        timeZone: CALENDAR_TIMEZONE
      },
      end: {
        dateTime: toCalendarDateTime(endDate),
        timeZone: CALENDAR_TIMEZONE
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Google Calendar no creo el evento: ${response.status}`);
  }
}

function ensureCalendarConfig() {
  if (!process.env.GOOGLE_CALENDAR_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error("Google Calendar no configurado");
  }
}

async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT"
  };
  const payload = {
    iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const signature = crypto.createSign("RSA-SHA256").update(unsignedToken).sign(privateKey);
  const assertion = `${unsignedToken}.${base64Url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (!response.ok) {
    throw new Error(`Google OAuth respondio ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function slotDate(fecha, hora) {
  return new Date(`${fecha}T${hora}:00-06:00`);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && leftEnd > rightStart;
}

function toCalendarDateTime(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: CALENDAR_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function createSmtpTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !process.env.FROM_EMAIL) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });
}

function buildWhatsAppUrl(cita) {
  const phone = cita.telefono.replace(/[^\d]/g, "");
  // GoTo usa el folio solo como referencia durante la llamada o IVR.
  const ivrLine = process.env.GOTO_IVR_PHONE ? ` Telefono IVR GoTo: ${process.env.GOTO_IVR_PHONE}.` : "";
  const message = [
    `Hola, ${cita.nombre}. Tu cita con Inmobiliaria Carvalho fue registrada correctamente.`,
    "",
    `Folio: ${cita.folio}`,
    `Tipo de cita: ${cita.tipo}`,
    `Fecha: ${cita.fecha}`,
    `Hora: ${cita.hora}`,
    "",
    "Para reagendar, cancelar o hablar con un asesor, llama al IVR de GoTo y ten a la mano tu folio.",
    ivrLine
  ].filter(Boolean).join("\n");

  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

async function sendAppointmentEmails(cita) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !FROM_EMAIL) {
    console.log(`Correo omitido para ${cita.folio}: variables SMTP incompletas.`);
    return false;
  }

  try {
    const transporter = createSmtpTransporter();

    const customerEmailSent = await sendCustomerConfirmation(transporter, cita, FROM_EMAIL);
    await sendInternalNotification(transporter, cita, FROM_EMAIL);
    return customerEmailSent;
  } catch (error) {
    console.error(`No se pudo completar el envio de correo para ${cita.folio}:`, error.message);
    return false;
  }
}

async function sendIvrActionEmails(cita, action, message) {
  const transporter = createSmtpTransporter();

  if (!transporter) {
    console.log(`Correo IVR omitido para ${cita.folio}: variables SMTP incompletas.`);
    return;
  }

  await sendIvrCustomerEmail(transporter, cita, process.env.FROM_EMAIL, action, message);
  await sendIvrInternalEmail(transporter, cita, process.env.FROM_EMAIL, action, message);
}

async function sendIvrCustomerEmail(transporter, cita, fromEmail, action, message) {
  if (!cita.correo) {
    return;
  }

  try {
    await transporter.sendMail({
      from: fromEmail,
      to: cita.correo,
      subject: `Actualizacion de cita ${cita.folio}`,
      text: [
        `Nombre: ${cita.nombre}`,
        `Folio: ${cita.folio}`,
        `Accion IVR: ${action}`,
        `Estatus: ${cita.estatus}`,
        `Tipo de cita: ${cita.tipo}`,
        `Fecha: ${cita.fecha}`,
        `Hora: ${cita.hora}`,
        "",
        message,
        "Conserva tu folio para cualquier seguimiento con el IVR de GoTo.",
        process.env.GOTO_IVR_PHONE ? `Telefono GoTo IVR: ${process.env.GOTO_IVR_PHONE}` : ""
      ].filter(Boolean).join("\n")
    });
  } catch (error) {
    console.error(`No se pudo enviar correo IVR al cliente para ${cita.folio}:`, error.message);
  }
}

async function sendIvrInternalEmail(transporter, cita, fromEmail, action, message) {
  if (!process.env.INTERNAL_NOTIFY_EMAIL) {
    return;
  }

  try {
    await transporter.sendMail({
      from: fromEmail,
      to: process.env.INTERNAL_NOTIFY_EMAIL,
      subject: `Accion IVR ${action} - ${cita.folio}`,
      text: [
        `Folio: ${cita.folio}`,
        `Accion IVR: ${action}`,
        `Mensaje: ${message}`,
        `Nombre del cliente: ${cita.nombre}`,
        `Telefono: ${cita.telefono}`,
        `Correo: ${cita.correo}`,
        `Tipo de cita: ${cita.tipo}`,
        `Fecha: ${cita.fecha}`,
        `Hora: ${cita.hora}`,
        `Comentarios: ${cita.comentarios || "Sin comentarios"}`,
        `Estatus: ${cita.estatus}`,
        `Actualizado: ${cita.updatedAt}`
      ].join("\n")
    });
  } catch (error) {
    console.error(`No se pudo enviar correo interno IVR para ${cita.folio}:`, error.message);
  }
}

async function sendIvrContactRequestEmail(solicitud) {
  if (!process.env.INTERNAL_NOTIFY_EMAIL) {
    return;
  }

  const transporter = createSmtpTransporter();

  if (!transporter) {
    console.log("Correo de solicitud IVR omitido: variables SMTP incompletas.");
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.FROM_EMAIL,
      to: process.env.INTERNAL_NOTIFY_EMAIL,
      subject: "Nueva solicitud por IVR - Inmobiliaria Carvalho",
      text: [
        `Telefono: ${solicitud.telefono}`,
        `Propiedad de interes: ${solicitud.propiedad}`,
        `Origen: ${solicitud.origen}`,
        `Fecha de solicitud: ${solicitud.createdAt}`,
        "Accion requerida: contactar al cliente a la brevedad"
      ].join("\n")
    });
  } catch (error) {
    console.error("No se pudo enviar solicitud interna IVR:", error.message);
  }
}

async function sendCustomerConfirmation(transporter, cita, fromEmail) {
  try {
    await transporter.sendMail({
      from: fromEmail,
      to: cita.correo,
      subject: `Confirmacion de cita ${cita.folio}`,
      text: [
        `Nombre: ${cita.nombre}`,
        `Folio: ${cita.folio}`,
        `Tipo de cita: ${cita.tipo}`,
        cita.propiedad ? `Propiedad: ${cita.propiedad}` : "",
        `Fecha: ${cita.fecha}`,
        `Hora: ${cita.hora}`,
        "",
        "Conserva tu folio. Lo necesitaras si llamas al IVR de GoTo para reagendar, cancelar o confirmar tu visita.",
        process.env.GOTO_IVR_PHONE ? `Telefono GoTo IVR: ${process.env.GOTO_IVR_PHONE}` : "",
        "",
        "Gracias."
      ].filter(Boolean).join("\n")
    });
    return true;
  } catch (error) {
    console.error(`No se pudo enviar correo al cliente para ${cita.folio}:`, error.message);
    return false;
  }
}

async function sendInternalNotification(transporter, cita, fromEmail) {
  if (!process.env.INTERNAL_NOTIFY_EMAIL) {
    return;
  }

  try {
    await transporter.sendMail({
      from: fromEmail,
      to: process.env.INTERNAL_NOTIFY_EMAIL,
      subject: `Nueva cita inmobiliaria ${cita.folio}`,
      text: [
        `Folio: ${cita.folio}`,
        `Nombre del cliente: ${cita.nombre}`,
        `Telefono: ${cita.telefono}`,
        `Correo: ${cita.correo}`,
        `Tipo de cita: ${cita.tipo}`,
        cita.propiedad ? `Propiedad: ${cita.propiedad}` : "",
        `Fecha: ${cita.fecha}`,
        `Hora: ${cita.hora}`,
        `Comentarios: ${cita.comentarios || "Sin comentarios"}`,
        `Estatus: ${cita.estatus}`,
        `Fecha de creacion: ${cita.createdAt}`
      ].join("\n")
    });
  } catch (error) {
    console.error(`No se pudo enviar notificacion interna para ${cita.folio}:`, error.message);
  }
}
