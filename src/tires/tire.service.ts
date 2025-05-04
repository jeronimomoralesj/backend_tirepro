import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateTireDto } from './dto/create-tire.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { uploadFileToS3 } from './s3.service';
import * as XLSX from 'xlsx';

@Injectable()
export class TireService {
  constructor(private readonly prisma: PrismaService) {}

  // Helper function to generate a random string of given length.
  private generateRandomString(length: number): string {
    let result = "";
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
  }

async createTire(createTireDto: CreateTireDto) {
    let { placa, marca, diseno, profundidadInicial, dimension, eje, vida, costo, inspecciones, 
      primeraVida, kilometrosRecorridos, eventos, companyId, vehicleId, posicion } = createTireDto;

    // Check if company exists
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      throw new BadRequestException('Invalid companyId provided');
    }

    // If vehicleId is provided, check if vehicle exists.
    let vehicle;
    if (vehicleId) {
      vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
      if (!vehicle) {
        throw new BadRequestException('Invalid vehicleId provided');
      }
    }

    // If the placa is not provided or empty, generate a unique random string.
    const finalPlaca = placa && placa.trim() !== "" ? placa : this.generateRandomString(8);

    // Create the tire record.
    const newTire = await this.prisma.tire.create({
      data: {
        placa: finalPlaca,
        marca,
        diseno,
        profundidadInicial,
        dimension,
        eje,
        vida: vida ?? [], 
        costo: costo ?? [],
        inspecciones: inspecciones ?? [],
        primeraVida: primeraVida ?? [],
        kilometrosRecorridos: kilometrosRecorridos ?? 0,
        eventos: eventos ?? [],
        companyId,
        vehicleId: vehicleId || null,
        posicion, // Use the provided posicion
      },
    });

    // Increment the company's tireCount by 1.
    await this.prisma.company.update({
      where: { id: companyId },
      data: { tireCount: { increment: 1 } },
    });

    // If a vehicle is specified, increment its tireCount.
    if (vehicleId) {
      await this.prisma.vehicle.update({
        where: { id: vehicleId },
        data: { tireCount: { increment: 1 } },
      });
    }

    return newTire;
}

async bulkUploadTires(file: any, companyId: string) {
  // 1. Read workbook & first sheet
  const wb = XLSX.read(file.buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, {
    raw: false,
    defval: '',
  });

  for (const row of rows) {
    // case‐insensitive cell lookup
    const get = (h: string) => {
      const key = Object.keys(row).find(k => k.toLowerCase() === h.toLowerCase());
      return key ? row[key] : '';
    };

    // 2. Mandatory tire fields
    const placa = get('placa').trim();
    if (!placa) continue;

    const marca              = get('marca').toLowerCase();
    const diseno             = get('diseno').toLowerCase();
    const profundidadInicial = parseFloat(get('profundidadinicial') || '0');
    const dimension          = get('dimension').toLowerCase();
    const eje                = get('eje').toLowerCase();
    const posicion           = parseInt(get('posicion') || '0', 10);
    const initialKm          = parseFloat(get('kilometrosrecorridos') || '0');

    // optional single‐life entry
    const vidaValor = get('vida').trim().toLowerCase();

    // 3. Optional vehicle lookup
    const vehiclePlaca = get('vehicleplaca').trim();
    let vehicle: { id: string } | null = null;
    if (vehiclePlaca) {
      const found = await this.prisma.vehicle.findFirst({ where: { placa: vehiclePlaca } });
      if (!found) {
        throw new BadRequestException(`Vehicle "${vehiclePlaca}" not found`);
      }
      vehicle = found;
    }

    // 4. Create the tire if missing
    let tire = await this.prisma.tire.findFirst({ where: { placa } });
    if (!tire) {
      tire = await this.prisma.tire.create({
        data: {
          placa,
          marca,
          diseno,
          profundidadInicial,
          dimension,
          eje,
          companyId,
          vehicleId: vehicle?.id ?? null,
          posicion,
          kilometrosRecorridos: initialKm,
          vida: vidaValor
            ? [{ fecha: new Date().toISOString(), valor: vidaValor }]
            : [],
          costo: [],
          inspecciones: [],
          primeraVida: [],
          eventos: [],
        },
      });

      // bump counts
      await this.prisma.company.update({
        where: { id: companyId },
        data: { tireCount: { increment: 1 } },
      });
      if (vehicle) {
        await this.prisma.vehicle.update({
          where: { id: vehicle.id },
          data: { tireCount: { increment: 1 } },
        });
      }
    }

    // 5. Detect new costo or inspection or vida
    const costoCell     = get('costo').trim();
    const hasCosto      = costoCell !== '';
    const hasInspection =
      !!get('profundidadint').trim() ||
      !!get('profundidadcen').trim() ||
      !!get('profundidadext').trim() ||
      !!get('newkilometraje').trim();

    if (hasCosto || hasInspection || vidaValor) {
      // re‑fetch only the fields we need
      const rec = await this.prisma.tire.findUnique({
        where: { id: tire.id },
        select: {
          vida: true,
          costo: true,
          inspecciones: true,
          profundidadInicial: true,
        },
      });
      if (!rec) {
        throw new BadRequestException('Tire not found on re‑fetch');
      }

      const updates: any = {};

      // — append vida
      if (vidaValor) {
        updates.vida = [
          ...(Array.isArray(rec.vida) ? rec.vida : []),
          { fecha: new Date().toISOString(), valor: vidaValor },
        ];
      }

      // — append costo
      let updatedCosto = Array.isArray(rec.costo) ? rec.costo : [];
      if (hasCosto) {
        const valor = parseFloat(costoCell) || 0;
        if (valor > 0) {
          updatedCosto = [
            ...updatedCosto,
            { fecha: new Date().toISOString(), valor },
          ];
          updates.costo = updatedCosto;
        }
      }

      // — handle inspection + CPK logic
      if (hasInspection) {
        const newKm    = parseFloat(get('newkilometraje') || '0');
        const profInt  = parseFloat(get('profundidadint') || '0');
        const profCen  = parseFloat(get('profundidadcen') || '0');
        const profExt  = parseFloat(get('profundidadext') || '0');
        const minDepth = Math.min(profInt, profCen, profExt);

        // total cost so far
        const totalCost = (updates.costo ?? updatedCosto).reduce(
          (sum: number, e: any) => sum + (e.valor || 0),
          0
        );

        // CPK = totalCost / kilometers driven
        const cpk = newKm > 0 ? totalCost / newKm : 0;

        // Projected kms before hitting min depth:
        // projectedKm = newKm / (initialDepth – minDepth) × initialDepth
        const initialDepthValue = rec.profundidadInicial;   // **correct spelling**
        const projectedKm =
          initialDepthValue > minDepth
            ? (newKm / (initialDepthValue - minDepth)) * initialDepthValue
            : 0;
        const cpkProyectado = projectedKm > 0 ? totalCost / projectedKm : 0;

        updates.inspecciones = [
          ...(Array.isArray(rec.inspecciones) ? rec.inspecciones : []),
          {
            fecha:           new Date().toISOString(),
            profundidadInt:  profInt,
            profundidadCen:  profCen,
            profundidadExt:  profExt,
            cpk,
            cpkProyectado,
            imageUrl: get('imageurl') || '',
          },
        ];

        updates.kilometrosRecorridos = newKm;
      }

      // 6. Persist updates in one go
      if (Object.keys(updates).length) {
        await this.prisma.tire.update({
          where: { id: tire.id },
          data: updates,
        });
      }
    }
  }

  return { message: 'Bulk upload complete' };
}

async findTiresByCompany(companyId: string) {
    return await this.prisma.tire.findMany({
      where: { companyId },
    });
}

async findTiresByVehicle(vehicleId: string) {
    if (!vehicleId) {
      throw new BadRequestException('vehicleId is required');
    }
    return await this.prisma.tire.findMany({
      where: { vehicleId },
    });
}

async updateInspection(tireId: string, updateDto: UpdateInspectionDto) {
  // Retrieve the tire.
  const tire = await this.prisma.tire.findUnique({
    where: { id: tireId },
  });
  if (!tire) {
    throw new BadRequestException('Tire not found');
  }

  // Retrieve the associated vehicle.
  if (!tire.vehicleId) {
    throw new BadRequestException('Tire is not associated with a vehicle');
  }
  const vehicle = await this.prisma.vehicle.findUnique({
    where: { id: tire.vehicleId },
  });
  if (!vehicle) {
    throw new BadRequestException('Vehicle not found for tire');
  }

  // Step 1: Calculate the delta in vehicle kilometraje.
  const oldVehicleKm = vehicle.kilometrajeActual;
  const deltaKm = updateDto.newKilometraje - oldVehicleKm;
  if (deltaKm < 0) {
    throw new BadRequestException('El nuevo kilometraje debe ser mayor o igual al actual');
  }

  // Step 2: Atomically increment the tire's kilometrosRecorridos by deltaKm.
  await this.prisma.tire.update({
    where: { id: tireId },
    data: { kilometrosRecorridos: { increment: deltaKm } },
  });

  // Re-fetch the tire to obtain the updated kilometrosRecorridos.
  const updatedTire = await this.prisma.tire.findUnique({
    where: { id: tireId },
  });
  if (!updatedTire) {
    throw new BadRequestException('Tire not found after update');
  }
  const newTireKm = updatedTire.kilometrosRecorridos;

  // Step 3: Calculate the total cost by summing the costo array.
  const totalCost = Array.isArray(updatedTire.costo)
    ? updatedTire.costo.reduce((sum, entry: any) => sum + (entry?.valor || 0), 0)
    : 0;

  // Step 4: Calculate cost per kilometer (cpk).
  const cpk = newTireKm > 0 ? totalCost / newTireKm : 0;

  // Step 5: Determine the smallest provided depth.
  const minDepth = Math.min(updateDto.profundidadInt, updateDto.profundidadCen, updateDto.profundidadExt);

  // Step 6: Calculate the projected cost per kilometer (cpkProyectado).
  const profundidadInicial = updatedTire.profundidadInicial; // Assuming this field exists on the tire
  const denominator = (newTireKm / (profundidadInicial - minDepth)) * profundidadInicial;
  const cpkProyectado = denominator > 0 ? totalCost / denominator : 0;
  
  // Step 7: Process image upload if an image was provided in the updateDto.
  let finalImageUrl = updateDto.imageUrl;
  if (updateDto.imageUrl && updateDto.imageUrl.startsWith("data:")) {
    const base64Data = updateDto.imageUrl.split(',')[1];
    const fileBuffer = Buffer.from(base64Data, 'base64');
    const fileName = `tire-inspections/${tireId}-${Date.now()}.jpg`;
    finalImageUrl = await uploadFileToS3(fileBuffer, fileName, 'image/jpeg');
  }

  // Step 8: Create the new inspection object.
  const newInspection = {
    profundidadInt: updateDto.profundidadInt,
    profundidadCen: updateDto.profundidadCen,
    profundidadExt: updateDto.profundidadExt,
    imageUrl: finalImageUrl,
    cpk,
    cpkProyectado,
    fecha: new Date().toISOString(),
  };

  // Step 9: Append the new inspection to the existing inspecciones array.
  const currentInspecciones = Array.isArray(updatedTire.inspecciones)
    ? updatedTire.inspecciones
    : [];
  const updatedInspecciones = [...currentInspecciones, newInspection];

  // Step 10: Update the tire record with the new inspecciones and confirm kilometrosRecorridos.
  const finalTire = await this.prisma.tire.update({
    where: { id: tireId },
    data: {
      inspecciones: updatedInspecciones,
      kilometrosRecorridos: newTireKm,
    },
  });

  // Step 11: Update the vehicle's kilometrajeActual to the new value.
  await this.prisma.vehicle.update({
    where: { id: vehicle.id },
    data: { kilometrajeActual: updateDto.newKilometraje },
  });

  return finalTire;
}
  
async updateVida(tireId: string, newValor: string) {
  // Allowed order for vida values.
  const allowed = ["nueva", "reencauche1", "reencauche2", "reencauche3", "fin"];

  // Retrieve the tire.
  const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
  if (!tire) {
    throw new BadRequestException("Tire not found");
  }

  // Ensure the vida array is always initialized properly.
  const vidaArray = Array.isArray(tire.vida)
    ? tire.vida as Array<{ fecha: string; valor: string }>
    : [];

  const lastEntry = vidaArray.length > 0 ? vidaArray[vidaArray.length - 1] : null;
  if (lastEntry) {
    const lastIndex = allowed.indexOf(lastEntry.valor.toLowerCase());
    const newIndex = allowed.indexOf(newValor.toLowerCase());
    if (newIndex === -1) {
      throw new BadRequestException("El valor ingresado no es válido");
    }
    if (newIndex <= lastIndex) {
      throw new BadRequestException(
        `El nuevo valor debe seguir la secuencia. Último valor: "${lastEntry.valor}". Puedes elegir: "${allowed[lastIndex + 1] || "ninguno"}".`
      );
    }
  }

  // Create the new vida entry.
  const newEntry = {
    fecha: new Date().toISOString(),
    valor: newValor,
  };
  const updatedVida = [...vidaArray, newEntry];

  // Prepare the update data (using a plain object type).
  const updateData: { [key: string]: any } = { vida: updatedVida };

  // If updating to "reencauche1", capture extra details.
  if (newValor.toLowerCase() === "reencauche1") {
    let cpk = 0;
    if (Array.isArray(tire.inspecciones) && tire.inspecciones.length > 0) {
      const inspections = tire.inspecciones as Array<{ fecha: string; cpk?: number }>;
      const validInspections = inspections.filter((i) => i && i.fecha);
      const sortedInspections = validInspections.sort(
        (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()
      );
      cpk = sortedInspections[0]?.cpk ?? 0;
    }
    const diseno = tire.diseno;
    let costo = 0;
    if (Array.isArray(tire.costo) && tire.costo.length > 0) {
      const lastCosto = tire.costo[tire.costo.length - 1] as { valor?: number } | null;
      if (lastCosto) {
        costo = typeof lastCosto.valor === "number" ? lastCosto.valor : 0;
      }
    }
    const kilometros = tire.kilometrosRecorridos ?? 0;
    updateData.primeraVida = [{ diseno, cpk, costo, kilometros }];
  }

  // If updating to "fin", disassociate the tire from its vehicle and decrement the vehicle's tireCount.
  if (newValor.toLowerCase() === "fin") {
    updateData.vehicleId = null;
    if (tire.vehicleId) {
      await this.prisma.vehicle.update({
        where: { id: tire.vehicleId },
        data: { tireCount: { decrement: 1 } },
      });
    }
  }

  const updatedTire = await this.prisma.tire.update({
    where: { id: tireId },
    data: updateData,
  });

  return updatedTire;
}

async updateEvento(tireId: string, newValor: string) {
  // Fetch the tire.
  const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
  if (!tire) {
    throw new BadRequestException('Tire not found');
  }
  
  // Parse the existing eventos array (if any).
  const eventosArray: { valor: string; fecha: string }[] = Array.isArray(tire.eventos)
    ? tire.eventos as any
    : [];
  
  // Create a new event entry.
  const newEvent = {
    valor: newValor,
    fecha: new Date().toISOString(),
  };
  
  // Append the new event.
  const updatedEventos = [...eventosArray, newEvent];
  
  // Update the tire record with the new eventos array.
  const updatedTire = await this.prisma.tire.update({
    where: { id: tireId },
    data: { eventos: updatedEventos },
  });
  
  return updatedTire;
}

async updatePositions(placa: string, updates: { [position: string]: string }) {
  // Find the vehicle by placa
  const vehicle = await this.prisma.vehicle.findFirst({
    where: { placa }
  });
  if (!vehicle) {
    throw new BadRequestException('Vehicle not found for the given placa');
  }

  // For each update, verify that the tire belongs to this vehicle and update its position.
  for (const pos in updates) {
    const tireId = updates[pos];
    const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
    if (!tire) {
      throw new BadRequestException(`Tire with id ${tireId} not found`);
    }
    if (tire.vehicleId !== vehicle.id) {
      throw new BadRequestException(`Tire with id ${tireId} does not belong to vehicle with plate ${placa}`);
    }
    await this.prisma.tire.update({
      where: { id: tireId },
      data: { posicion: parseInt(pos, 10) }
    });
  }

  return { message: 'Positions updated successfully' };
}

async analyzeTires(vehiclePlaca: string) {
  // Fetch the vehicle by placa
  const vehicle = await this.prisma.vehicle.findFirst({
    where: { placa: vehiclePlaca }
  });
  
  if (!vehicle) {
    throw new BadRequestException(`Vehicle with placa ${vehiclePlaca} not found`);
  }
  
  // Fetch all tires for this vehicle
  const tires = await this.prisma.tire.findMany({
    where: { vehicleId: vehicle.id }
  });
  
  if (!tires || tires.length === 0) {
    throw new BadRequestException(`No tires found for vehicle with placa ${vehiclePlaca}`);
  }
  
  // Analyze each tire using the decision tree
  const analysisResults = tires.map(tire => this.analyzeTire(tire));
  
  return {
    vehicle,
    tires: analysisResults
  };
}

private analyzeTire(tire: any) {
  // If no inspections, return a default recommendation
  if (!tire.inspecciones || !Array.isArray(tire.inspecciones) || tire.inspecciones.length === 0) {
    return {
      id: tire.id,
      posicion: tire.posicion,
      profundidadActual: null,
      inspecciones: [],
      recomendaciones: [
        "🔴 **Inspección requerida:** No se han registrado inspecciones para esta llanta. Se recomienda realizar una inspección inmediata para evaluar su estado y asegurar la seguridad del vehículo."
      ]
    };
  }

  // Sort inspections by date descending and take the last three
  const lastInspections = [...tire.inspecciones]
    .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
    .slice(0, 3);

  const latestInspection = lastInspections[0];

  // Calculate the average depth
  const profundidadInt = Number(latestInspection.profundidadInt) || 0;
  const profundidadCen = Number(latestInspection.profundidadCen) || 0;
  const profundidadExt = Number(latestInspection.profundidadExt) || 0;
  const profundidadActual = (profundidadInt + profundidadCen + profundidadExt) / 3;

  let recomendaciones: string[] = [];

  if (profundidadActual <= 2) {
    recomendaciones.push("🔴 **Cambio inmediato:** La llanta tiene un desgaste crítico y debe ser reemplazada.");
  } else if (profundidadActual <= 4) {
    recomendaciones.push("🟡 **Revisión frecuente:** Se recomienda monitorear esta llanta en cada inspección.");
  } else {
    recomendaciones.push("🟢 **En buen estado:** No se requiere acción inmediata.");
  }

  return {
    id: tire.id,
    posicion: tire.posicion,
    profundidadActual,
    inspecciones: lastInspections,
    recomendaciones
  };
}

async removeInspection(tireId: string, fecha: string) {
  const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
  if (!tire) throw new BadRequestException('Tire not found');

  // 1️⃣ Narrow the JSON field into an array
  const inspeccionesArray = Array.isArray(tire.inspecciones)
    ? tire.inspecciones as Array<{ fecha: string }>
    : [];

  // 2️⃣ Filter out the one with the matching fecha
  const updated = inspeccionesArray.filter(i => i.fecha !== fecha);

  // 3️⃣ Persist back as JSON
  await this.prisma.tire.update({
    where: { id: tireId },
    data: { inspecciones: updated },
  });

  return { message: 'Inspección eliminada' };
}
  
}
