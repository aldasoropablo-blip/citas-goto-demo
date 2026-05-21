const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// En esta demo las citas se guardan temporalmente en memoria.
// Para produccion debe usarse una base persistente como PostgreSQL, Google Sheets, Airtable o CRM.
const citas = [];
const solicitudesIvr = [];
let folioCounter = 1;

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

  const cita = {
    // El folio se genera en esta app externa; no vive en GoTo.
    folio: nextFolio(),
    nombre: clean(nombre),
    telefono: clean(telefono),
    correo: clean(correo),
    tipo: clean(tipo),
    fecha: clean(fecha),
    hora: clean(hora),
    comentarios: clean(comentarios),
    estatus: "Confirmada",
    whatsappUrl: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  cita.whatsappUrl = buildWhatsAppUrl(cita);
  citas.push(cita);

  cita.emailSent = await sendAppointmentEmails(cita);

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

app.post("/api/ivr/solicitudes", async (req, res) => {
  const telefono = clean(req.body.telefono);
  const propiedad = clean(req.body.propiedad) || "No especificada";
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

function findCita(folio) {
  return citas.find((cita) => cita.folio.toLowerCase() === String(folio).toLowerCase());
}

function ivrNotFound() {
  return {
    ok: true,
    found: false,
    message: "No encontramos una cita con ese folio."
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
