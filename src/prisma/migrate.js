// migrate.js
const { MongoClient } = require("mongodb");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Replace with your MongoDB connection string and database/collection names.
const MONGO_URI = "mongodb+srv://moraljero:Anajaramillo1@cluster0.ffedm.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const MONGO_DB_NAME = "test";   // Change this to your actual DB name
const MONGO_COLLECTION = "tire_data";            // Change this to your actual collection name

// Company to assign migrated data
const COMPANY_ID = "453158cc-fc55-4161-9ed8-0fc004bf1ce8";

function parseDate(obj) {
  // Given an object { day, month, year, value }, create an ISO date.
  if (obj.day && obj.month && obj.year) {
    return new Date(obj.year, obj.month - 1, obj.day).toISOString();
  }
  return new Date().toISOString();
}

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log("Connected to MongoDB");

  const db = client.db(MONGO_DB_NAME);
  const collection = db.collection(MONGO_COLLECTION);
  const cursor = collection.find({});

  // Map to store created vehicles based on their placa (vehicle identifier)
  const vehicleMap = new Map();

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    console.log(`Processing Mongo document with _id: ${doc._id}`);

    // --- 1. Create Vehicle (if not already done) ---
    let vehicleId = null;
    if (doc.placa) {
      if (vehicleMap.has(doc.placa)) {
        vehicleId = vehicleMap.get(doc.placa);
      } else {
        // Example: extract vehicle data.
        // For kilometer, pick the last element of the kilometraje_actual array if available.
        let kilometrajeActual = 0;
        if (Array.isArray(doc.kilometraje_actual) && doc.kilometraje_actual.length > 0) {
          const lastEntry = doc.kilometraje_actual[doc.kilometraje_actual.length - 1];
          kilometrajeActual = lastEntry.value;
        }
        // Assume additional fields like "carga" and "tipovhc" exist in doc.
        const newVehicle = await prisma.vehicle.create({
          data: {
            placa: doc.placa,
            kilometrajeActual,
            carga: doc.frente || "unknown", // adjust according to your field mapping
            pesoCarga: doc.pesoCarga || 0,    // use a default or parse if available
            tipovhc: doc.tipovhc || "unknown",
            companyId: COMPANY_ID,
            tireCount: 0
          }
        });
        vehicleId = newVehicle.id;
        vehicleMap.set(doc.placa, vehicleId);
        console.log(`Created Vehicle ${vehicleId} for placa ${doc.placa}`);
      }
    }

    // --- 2. Transform Tire Data ---
    // Transform the 'vida' array from Mongo (if exists)
    const vida = [];
    if (Array.isArray(doc.vida)) {
      for (const entry of doc.vida) {
        vida.push({
          fecha: parseDate(entry),
          valor: entry.value
        });
      }
    }

    // Transform "costo": if a single value exists (or an array) adjust accordingly.
    const costo = [];
    if (doc.costo && typeof doc.costo === "number") {
      costo.push({ fecha: new Date().toISOString(), valor: doc.costo });
    }
    // Alternatively, if doc.costo is an array then loop through it:
    if (Array.isArray(doc.costo)) {
      for (const entry of doc.costo) {
        costo.push({ fecha: parseDate(entry), valor: entry.value });
      }
    }

    // Transform inspection arrays into a single inspections array.
    const inspecciones = [];
    if (
      Array.isArray(doc.profundidad_int) &&
      Array.isArray(doc.profundidad_cen) &&
      Array.isArray(doc.profundidad_ext) &&
      Array.isArray(doc.cpk) &&
      Array.isArray(doc.cpk_proy)
    ) {
      const len = Math.min(
        doc.profundidad_int.length,
        doc.profundidad_cen.length,
        doc.profundidad_ext.length,
        doc.cpk.length,
        doc.cpk_proy.length
      );
      for (let i = 0; i < len; i++) {
        // Use the date from one of the arrays.
        const fecha = parseDate(doc.profundidad_int[i]);
        inspecciones.push({
          profundidadInt: doc.profundidad_int[i].value,
          profundidadCen: doc.profundidad_cen[i].value,
          profundidadExt: doc.profundidad_ext[i].value,
          cpk: doc.cpk[i].value,
          cpkProyectado: doc.cpk_proy[i].value,
          imageUrl: "", // Optionally, use images if available (e.g., from doc.images)
          fecha
        });
      }
    }

    // For the tire's position, take the first item from the "pos" array.
    let posicion = 0;
    if (Array.isArray(doc.pos) && doc.pos.length > 0) {
      posicion = doc.pos[0].value;
    }

    // Use the field "profundidad_inicial" as is (or convert if needed)
    const profundidadInicial = doc.profundidad_inicial || 0;

    // For kilometers traveled, use the "kms" array (e.g., take the last value)
    let kilometrosRecorridos = 0;
    if (Array.isArray(doc.kms) && doc.kms.length > 0) {
      const lastKm = doc.kms[doc.kms.length - 1];
      kilometrosRecorridos = lastKm.value;
    }

    // Other tire fields
    const tirePlaca = doc.llanta ? doc.llanta.toString() : (Math.random().toString(36).substring(2, 10));
    const marca = doc.marca || "";
    const diseno = doc.diseno || "";
    const dimension = doc.dimension || "";
    const eje = doc.eje || "";

    // You may also parse events if present.
    const eventos = [];
    if (Array.isArray(doc.eventos)) {
      for (const evt of doc.eventos) {
        eventos.push({
          fecha: parseDate(evt),
          valor: evt.value
        });
      }
    }

    // --- 3. Create the Tire record ---
    try {
      const newTire = await prisma.tire.create({
        data: {
          placa: tirePlaca,
          marca,
          diseno,
          profundidadInicial,
          dimension,
          eje,
          vida,
          costo,
          inspecciones,
          primeraVida: [], // You can add transformation logic if needed.
          kilometrosRecorridos,
          eventos,
          companyId: COMPANY_ID,
          vehicleId: vehicleId || null,
          posicion
        }
      });
      console.log(`Migrated Tire ${newTire.id}`);
    } catch (error) {
      console.error(`Error creating tire for Mongo _id ${doc._id}: ${error.message}`);
    }
  }

  await client.close();
  await prisma.$disconnect();
  console.log("Migration complete.");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
});
