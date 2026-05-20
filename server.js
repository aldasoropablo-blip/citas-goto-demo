const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const citas = [];
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

app.post("/api/citas", async (req, res) => {
  const { nombre, telefono, correo, tipo, fecha, hora, comentarios } = req.body;

  if (!nombre || !telefono || !correo || !tipo || !fecha || !hora) {
    return res.status(400).json({
      error: "nombre, telefono, correo, tipo, fecha y hora son obligatorios"
    });
  }

  const cita = {
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

  await sendConfirmationEmail(cita);

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

function buildWhatsAppUrl(cita) {
  const phone = cita.telefono.replace(/[^\d]/g, "");
  const ivrLine = process.env.GOTO_IVR_PHONE
    ? ` Para cambios, llama a GoTo: ${process.env.GOTO_IVR_PHONE}.`
    : "";
  const message = `Hola ${cita.nombre}, tu cita ${cita.folio} de ${cita.tipo} esta ${cita.estatus} para el ${cita.fecha} a las ${cita.hora}.${ivrLine}`;

  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

async function sendConfirmationEmail(cita) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_EMAIL } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !FROM_EMAIL) {
    console.log(`Correo omitido para ${cita.folio}: variables SMTP incompletas.`);
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: FROM_EMAIL,
      to: cita.correo,
      subject: `Confirmacion de cita ${cita.folio}`,
      text: [
        `Hola ${cita.nombre},`,
        "",
        `Tu cita ${cita.folio} de ${cita.tipo} esta ${cita.estatus}.`,
        `Fecha: ${cita.fecha}`,
        `Hora: ${cita.hora}`,
        process.env.GOTO_IVR_PHONE ? `Telefono GoTo IVR: ${process.env.GOTO_IVR_PHONE}` : "",
        "",
        "Gracias."
      ].filter(Boolean).join("\n")
    });
  } catch (error) {
    console.error(`No se pudo enviar correo para ${cita.folio}:`, error.message);
  }
}
