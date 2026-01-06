import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateTireDto } from './dto/create-tire.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';
import { uploadFileToS3 } from './s3.service';
import * as XLSX from 'xlsx';
import { VehicleService } from 'src/vehicles/vehicle.service';
import { NotificationsService } from 'src/notifications/notifications.service';

@Injectable()
export class TireService {
  constructor(private readonly prisma: PrismaService,
    private readonly vehicleService: VehicleService, 
    private notificationsService: NotificationsService,
  ) {}

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
  const {
    placa,
    marca,
    diseno,
    profundidadInicial,
    dimension,
    eje,
    vida,
    costo,
    inspecciones,
    primeraVida,
    kilometrosRecorridos,
    eventos,
    companyId,
    vehicleId,
    posicion,
    desechos,
    fechaInstalacion, // 🆕 opcional
  } = createTireDto;

  // =========================
  // VALIDAR EMPRESA
  // =========================
  const company = await this.prisma.company.findUnique({
    where: { id: companyId },
  });
  if (!company) {
    throw new BadRequestException('Invalid companyId provided');
  }

  // =========================
  // VALIDAR VEHÍCULO (SI APLICA)
  // =========================
  let vehicle = null;
  if (vehicleId) {
    vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
    });
    if (!vehicle) {
      throw new BadRequestException('Invalid vehicleId provided');
    }
  }

  // =========================
  // PLACA FINAL
  // =========================
  const finalPlaca =
    placa && placa.trim() !== ''
      ? placa.trim().toLowerCase()
      : this.generateRandomString(8);

  // =========================
  // FECHA DE INSTALACIÓN
  // =========================
  const fechaInstalacionFinal =
    fechaInstalacion ? new Date(fechaInstalacion) : new Date();

  // =========================
  // CREAR LLANTA
  // =========================
  const newTire = await this.prisma.tire.create({
    data: {
      placa: finalPlaca,
      marca,
      diseno,
      profundidadInicial,
      dimension,
      eje,
      posicion,

      vida: Array.isArray(vida) ? vida : [],
      costo: Array.isArray(costo) ? costo : [],
      inspecciones: Array.isArray(inspecciones) ? inspecciones : [],
      primeraVida: Array.isArray(primeraVida) ? primeraVida : [],

      kilometrosRecorridos: kilometrosRecorridos ?? 0,
      eventos: Array.isArray(eventos) ? eventos : [],

      companyId,
      vehicleId: vehicleId ?? null,

      // 🆕 CAMPOS DE TIEMPO
      fechaInstalacion: fechaInstalacionFinal,
      diasAcumulados: 0,

      desechos: desechos ?? null,
    },
  });

  // =========================
  // CONTADORES
  // =========================
  await this.prisma.company.update({
    where: { id: companyId },
    data: { tireCount: { increment: 1 } },
  });

  if (vehicleId) {
    await this.prisma.vehicle.update({
      where: { id: vehicleId },
      data: { tireCount: { increment: 1 } },
    });
  }

  return newTire;
}

async bulkUploadTires(file: any, companyId: string) {
  const wb = XLSX.read(file.buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(sheet, {
    raw: false,
    defval: '',
  });

  const KM_POR_MES = 6000;
  const MS_POR_DIA = 1000 * 60 * 60 * 24;

  const headerMap: Record<string, string> = {
    'llanta': 'llanta',
    'numero de llanta': 'llanta',

    'placa vehiculo': 'placa_vehiculo',
    'placa': 'placa_vehiculo',

    'marca': 'marca',
    'diseno': 'diseno',
    'dimension': 'dimension',
    'eje': 'eje',
    'posicion': 'posicion',

    'vida': 'vida',

    'kilometros llanta': 'kilometros_llanta',
    'kilometraje vehiculo': 'kilometros_vehiculo',

    'profundidad int': 'profundidad_int',
    'profundidad cen': 'profundidad_cen',
    'profundidad ext': 'profundidad_ext',

    'profundidad inicial': 'profundidad_inicial',

    'costo': 'costo',

    'fecha instalacion': 'fecha_instalacion',

    'imageurl': 'imageurl',
  };

  const get = (row: any, header: string) => {
    const normalized = headerMap[header.toLowerCase()] || header.toLowerCase();
    const key = Object.keys(row).find(
      k =>
        headerMap[k.toLowerCase()] === normalized ||
        k.toLowerCase() === normalized,
    );
    return key ? row[key] : '';
  };

  const tireDataMap = new Map<string, { lastVida: string; lastCosto: number }>();

  for (const row of rows) {
    const tirePlaca = get(row, 'llanta')?.trim().toLowerCase();
    if (!tirePlaca) continue;

    const marca = get(row, 'marca').toLowerCase();
    const diseno = get(row, 'diseno').toLowerCase();
    const dimension = get(row, 'dimension').toLowerCase();
    const eje = get(row, 'eje').toLowerCase();
    const posicion = parseInt(get(row, 'posicion') || '0', 10);
    const vidaValor = get(row, 'vida').trim().toLowerCase();

    const profundidadInicial = parseFloat(
      get(row, 'profundidad_inicial') || '0',
    );

    const placaVehiculo = get(row, 'placa_vehiculo')?.trim().toLowerCase();
    const kilometrosVehiculo = parseFloat(
      get(row, 'kilometros_vehiculo') || '0',
    );

    let vehicle: any = null;

    if (placaVehiculo) {
      vehicle = await this.prisma.vehicle.findFirst({
        where: { placa: placaVehiculo },
      });

      if (!vehicle) {
        vehicle = await this.vehicleService.createVehicle({
          placa: placaVehiculo,
          kilometrajeActual: kilometrosVehiculo,
          carga: '',
          pesoCarga: 0,
          tipovhc: '',
          companyId,
          cliente: '',
        });
      } else if (kilometrosVehiculo > (vehicle.kilometrajeActual || 0)) {
        await this.vehicleService.updateKilometraje(
          vehicle.id,
          kilometrosVehiculo,
        );
        vehicle.kilometrajeActual = kilometrosVehiculo;
      }
    }

    let tire = await this.prisma.tire.findFirst({
      where: { placa: tirePlaca },
    });

    const fechaInstalacionRaw = get(row, 'fecha_instalacion');
    const fechaInstalacion = fechaInstalacionRaw
      ? new Date(fechaInstalacionRaw)
      : new Date();

    if (!tire) {
      tire = await this.prisma.tire.create({
        data: {
          placa: tirePlaca,
          marca,
          diseno,
          dimension,
          eje,
          posicion,
          profundidadInicial,
          companyId,
          vehicleId: vehicle?.id ?? null,
          fechaInstalacion,
          vida: vidaValor
            ? [{ fecha: new Date().toISOString(), valor: vidaValor }]
            : [],
          costo: [],
          inspecciones: [],
          eventos: [],
        },
      });

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

    const rec = await this.prisma.tire.findUnique({
      where: { id: tire.id },
    });
    if (!rec) continue;

    const now = new Date();

    const diasEnUso = Math.max(
      Math.floor(
        (now.getTime() -
          new Date(rec.fechaInstalacion ?? now).getTime()) /
          MS_POR_DIA,
      ),
      1,
    );

    const mesesEnUso = diasEnUso / 30;

    const kmLlantaExcel = parseFloat(
      get(row, 'kilometros_llanta') || '0',
    );

    const kilometrosEstimados =
      kmLlantaExcel > 0
        ? kmLlantaExcel
        : Math.round(mesesEnUso * KM_POR_MES);

    const costoCell = parseFloat(get(row, 'costo') || '0');

    const lastData =
      tireDataMap.get(tirePlaca) || { lastVida: '', lastCosto: -1 };

    const costosActuales = Array.isArray(rec.costo)
      ? (rec.costo as Array<{ valor?: number }>)
      : [];

    if (costoCell > 0 && costoCell !== lastData.lastCosto) {
      costosActuales.push({
        fecha: now.toISOString(),
        valor: costoCell,
      });
      lastData.lastCosto = costoCell;
    }

    const totalCost = costosActuales.reduce((sum, c) => {
      return sum + (typeof c?.valor === 'number' ? c.valor : 0);
    }, 0);

    let vidaArray = Array.isArray(rec.vida) ? rec.vida : [];

    if (vidaValor && vidaValor !== lastData.lastVida) {
      vidaArray = [
        ...vidaArray,
        { fecha: now.toISOString(), valor: vidaValor },
      ];
      lastData.lastVida = vidaValor;
    }

    const profInt = parseFloat(get(row, 'profundidad_int') || '0');
    const profCen = parseFloat(get(row, 'profundidad_cen') || '0');
    const profExt = parseFloat(get(row, 'profundidad_ext') || '0');

    const hasInspection = profInt > 0 || profCen > 0 || profExt > 0;

    if (hasInspection) {
      const minDepth = Math.min(profInt, profCen, profExt);

      const cpk =
        kilometrosEstimados > 0 ? totalCost / kilometrosEstimados : 0;

      const cpt = mesesEnUso > 0 ? totalCost / mesesEnUso : 0;

      const projectedKm =
        rec.profundidadInicial > minDepth
          ? (kilometrosEstimados /
              (rec.profundidadInicial - minDepth)) *
            rec.profundidadInicial
          : 0;

      const projectedMonths = projectedKm / KM_POR_MES;

      const inspecciones = [
        ...(Array.isArray(rec.inspecciones)
          ? rec.inspecciones
          : []),
        {
          fecha: now.toISOString(),
          profundidadInt: profInt,
          profundidadCen: profCen,
          profundidadExt: profExt,
          diasEnUso,
          mesesEnUso,
          kilometrosEstimados,
          cpk,
          cpkProyectado:
            projectedKm > 0 ? totalCost / projectedKm : 0,
          cpt,
          cptProyectado:
            projectedMonths > 0 ? totalCost / projectedMonths : 0,
          imageUrl: get(row, 'imageurl') || '',
        },
      ];

      await this.prisma.tire.update({
        where: { id: tire.id },
        data: {
          costo: costosActuales,
          vida: vidaArray,
          inspecciones,
          kilometrosRecorridos: Math.max(
            rec.kilometrosRecorridos || 0,
            kilometrosEstimados,
          ),
          diasAcumulados: diasEnUso,
        },
      });
    }

    tireDataMap.set(tirePlaca, lastData);
  }

  return { message: 'Carga masiva completada correctamente' };
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
  const KM_POR_MES = 6000;
  const MS_POR_DIA = 1000 * 60 * 60 * 24;

  // =========================
  // VALIDACIONES BÁSICAS
  // =========================
  const tire = await this.prisma.tire.findUnique({
    where: { id: tireId },
  });
  if (!tire) throw new BadRequestException('Tire not found');

  if (!tire.vehicleId) {
    throw new BadRequestException('Tire is not associated with a vehicle');
  }

  const vehicle = await this.prisma.vehicle.findUnique({
    where: { id: tire.vehicleId },
  });
  if (!vehicle) {
    throw new BadRequestException('Vehicle not found for tire');
  }

  // =========================
  // KILOMETRAJE VEHÍCULO
  // =========================
  const oldVehicleKm = vehicle.kilometrajeActual || 0;
  const newVehicleKm = updateDto.newKilometraje || 0;

  const odometerStuck =
    newVehicleKm === 0 || newVehicleKm === oldVehicleKm;

  let deltaKm = 0;

  if (!odometerStuck) {
    deltaKm = newVehicleKm - oldVehicleKm;
    if (deltaKm < 0) {
      throw new BadRequestException(
        'El nuevo kilometraje debe ser mayor o igual al actual',
      );
    }

    await this.prisma.tire.update({
      where: { id: tireId },
      data: { kilometrosRecorridos: { increment: deltaKm } },
    });
  }

  const updatedTire = await this.prisma.tire.findUnique({
    where: { id: tireId },
  });
  if (!updatedTire) {
    throw new BadRequestException('Tire not found after update');
  }

  // =========================
  // TIEMPO EN USO
  // =========================
  const now = new Date();
  const fechaInstalacion = updatedTire.fechaInstalacion ?? now;

  const diasEnUso = Math.max(
    Math.floor(
      (now.getTime() - new Date(fechaInstalacion).getTime()) /
        MS_POR_DIA,
    ),
    1,
  );

  const mesesEnUso = diasEnUso / 30;

  // =========================
  // KILOMETROS LLANTA (REAL O ESTIMADO)
  // =========================
  const realTireKm = updatedTire.kilometrosRecorridos || 0;
  const kilometrosEstimados = odometerStuck
    ? Math.round(mesesEnUso * KM_POR_MES)
    : realTireKm;

  // =========================
  // COSTO TOTAL
  // =========================
  const totalCost = Array.isArray(updatedTire.costo)
    ? updatedTire.costo.reduce(
        (sum, entry: any) => sum + (entry?.valor || 0),
        0,
      )
    : 0;

  // =========================
  // CPK / CPT
  // =========================
  const cpk =
    kilometrosEstimados > 0
      ? totalCost / kilometrosEstimados
      : 0;

  const cpt = mesesEnUso > 0 ? totalCost / mesesEnUso : 0;

  // =========================
  // PROFUNDIDADES
  // =========================
  const minDepth = Math.min(
    updateDto.profundidadInt,
    updateDto.profundidadCen,
    updateDto.profundidadExt,
  );

  const profundidadInicial = updatedTire.profundidadInicial;

  const projectedKm =
    profundidadInicial > minDepth
      ? (kilometrosEstimados /
          (profundidadInicial - minDepth)) *
        profundidadInicial
      : 0;

  const projectedMonths = projectedKm / KM_POR_MES;

  const cpkProyectado =
    projectedKm > 0 ? totalCost / projectedKm : 0;

  const cptProyectado =
    projectedMonths > 0 ? totalCost / projectedMonths : 0;

  // =========================
  // IMAGEN
  // =========================
  let finalImageUrl = updateDto.imageUrl;

  if (
    updateDto.imageUrl &&
    updateDto.imageUrl.startsWith('data:')
  ) {
    const base64Data = updateDto.imageUrl.split(',')[1];
    const fileBuffer = Buffer.from(base64Data, 'base64');
    const fileName = `tire-inspections/${tireId}-${Date.now()}.jpg`;

    finalImageUrl = await uploadFileToS3(
      fileBuffer,
      fileName,
      'image/jpeg',
    );
  }

  // =========================
  // NUEVA INSPECCIÓN
  // =========================
  const newInspection = {
    profundidadInt: updateDto.profundidadInt,
    profundidadCen: updateDto.profundidadCen,
    profundidadExt: updateDto.profundidadExt,
    imageUrl: finalImageUrl,
    fecha: now.toISOString(),

    diasEnUso,
    mesesEnUso,
    kilometrosEstimados,

    cpk,
    cpkProyectado,
    cpt,
    cptProyectado,
  };

  const currentInspecciones = Array.isArray(
    updatedTire.inspecciones,
  )
    ? updatedTire.inspecciones
    : [];

  const updatedInspecciones = [
    ...currentInspecciones,
    newInspection,
  ];

  // =========================
  // GUARDAR LLANTA
  // =========================
  const finalTire = await this.prisma.tire.update({
    where: { id: tireId },
    data: {
      inspecciones: updatedInspecciones,
      kilometrosRecorridos: kilometrosEstimados,
      diasAcumulados: diasEnUso,
    },
  });

  // =========================
  // ACTUALIZAR VEHÍCULO (SI APLICA)
  // =========================
  if (!odometerStuck) {
    await this.prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { kilometrajeActual: newVehicleKm },
    });
  }

  // =========================
  // NOTIFICACIONES
  // =========================
  await this.notificationsService.deleteByTire(finalTire.id);

  const analysis = this.analyzeTire(finalTire);
  const recommendation =
    analysis?.recomendaciones?.[0] ?? '';

  if (
    recommendation.startsWith('🔴') ||
    recommendation.startsWith('🟡')
  ) {
    await this.notificationsService.createNotification({
      title: `Llantas - ${
        recommendation.includes('🔴')
          ? 'Crítico'
          : 'Precaución'
      }`,
      message: recommendation,
      type: recommendation.includes('🔴')
        ? 'critical'
        : 'warning',
      tireId: finalTire.id,
      vehicleId: finalTire.vehicleId ?? undefined,
      companyId: finalTire.companyId ?? undefined,
    });
  }

  return finalTire;
}
  
async updateVida(
  tireId: string,
  newValor: string | undefined,
  banda?: string,
  costo?: number,
  profundidadInicial?: number | string, // Accept both types safely
  desechoData?: {
    causales: string;
    milimetrosDesechados: number;
  }
) {
  console.log('Backend Debug - Received parameters:', {
    tireId,
    newValor,
    banda,
    costo,
    profundidadInicial,
    profundidadInicialType: typeof profundidadInicial,
    desechoData
  });

  if (!newValor) {
    throw new BadRequestException(`El campo 'valor' es obligatorio`);
  }

  const normalizedValor = newValor.toLowerCase();
  const allowed = ['nueva', 'reencauche1', 'reencauche2', 'reencauche3', 'fin'];
  const newIndex = allowed.indexOf(normalizedValor);

  if (newIndex < 0) {
    throw new BadRequestException(`"${newValor}" no es un valor válido`);
  }

  let parsedProfundidad: number | null = null;

  if (normalizedValor !== 'fin') {
    if (
      profundidadInicial === undefined ||
      profundidadInicial === null ||
      (typeof profundidadInicial === 'string' && profundidadInicial.trim() === '')
    ) {
      throw new BadRequestException("La profundidad inicial es requerida para este valor de vida.");
    }

    parsedProfundidad =
      typeof profundidadInicial === 'string'
        ? parseFloat(profundidadInicial)
        : Number(profundidadInicial);

    if (isNaN(parsedProfundidad) || parsedProfundidad <= 0) {
      throw new BadRequestException("La profundidad inicial debe ser un número mayor a 0.");
    }
  }

  const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
  if (!tire) {
    throw new BadRequestException('Tire not found');
  }

  const vidaArray = (Array.isArray(tire.vida) ? tire.vida : []) as Array<{
    fecha: string;
    valor: string;
  }>;

  const lastEntry = vidaArray.length ? vidaArray[vidaArray.length - 1] : null;
  if (lastEntry) {
    const lastIndex = allowed.indexOf(lastEntry.valor.toLowerCase());
    if (lastIndex < 0) {
      throw new BadRequestException('Último valor de vida inválido');
    }
    if (newIndex <= lastIndex) {
      throw new BadRequestException(
        `Debe avanzar en la secuencia. Último valor: "${lastEntry.valor}".`
      );
    }
  }

  const updateData: any = {
    vida: [
      ...vidaArray,
      { fecha: new Date().toISOString(), valor: normalizedValor },
    ],
  };

  if (normalizedValor !== 'fin' && parsedProfundidad !== null) {
    updateData.profundidadInicial = parsedProfundidad;
  }

  if (banda?.trim()) {
    updateData.diseno = banda.trim();
  }

  if (normalizedValor.startsWith('reencauche')) {
    const existingCosto = Array.isArray(tire.costo) ? tire.costo : [];
    let costoValue = 0;

    if (typeof costo === 'number' && costo > 0) {
      costoValue = costo;
    } else if (
      normalizedValor === 'reencauche1' &&
      existingCosto.length
    ) {
      const lastC = existingCosto[existingCosto.length - 1] as any;
      costoValue = typeof lastC.valor === 'number' ? lastC.valor : 0;
    }

    if (costoValue > 0) {
      updateData.costo = [
        ...existingCosto,
        { fecha: new Date().toISOString(), valor: costoValue },
      ];
    }
  }

  if (normalizedValor === 'reencauche1') {
    let cpk = 0;
    if (Array.isArray(tire.inspecciones) && tire.inspecciones.length) {
      const insps = [...tire.inspecciones] as Array<{
        fecha: string;
        cpk?: number;
      }>;
      insps.sort(
        (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()
      );
      cpk = insps[0]?.cpk ?? 0;
    }

    const designValue = banda?.trim() || tire.diseno;
    const costoForPrimera =
      typeof costo === 'number' && costo > 0
        ? costo
        : Array.isArray(tire.costo) && tire.costo.length
        ? ((tire.costo[tire.costo.length - 1] as any).valor as number) || 0
        : 0;
    const kms = tire.kilometrosRecorridos || 0;

    updateData.primeraVida = [
      {
        diseno: designValue,
        cpk,
        costo: costoForPrimera,
        kilometros: kms,
      },
    ];
  }

  if (normalizedValor === 'fin') {
    updateData.vehicleId = null;

    if (tire.vehicleId) {
      await this.prisma.vehicle.update({
        where: { id: tire.vehicleId },
        data: { tireCount: { decrement: 1 } },
      });
    }

    if (!desechoData || !desechoData.causales || desechoData.milimetrosDesechados === undefined) {
      throw new BadRequestException('Información de desecho incompleta');
    }

    const profundidad = tire.profundidadInicial || 0;
    let lastCosto = 0;

    if (Array.isArray(tire.costo) && tire.costo.length > 0) {
      const lastEntry = tire.costo[tire.costo.length - 1] as any;
      lastCosto = typeof lastEntry.valor === 'number' ? lastEntry.valor : 0;
    }

    const cpk = profundidad > 0 ? lastCosto / profundidad : 0;
    const remanente = cpk * desechoData.milimetrosDesechados;

    updateData.desechos = {
      causales: desechoData.causales,
      milimetrosDesechados: desechoData.milimetrosDesechados,
      remanente: Number(remanente.toFixed(2)),
      fecha: new Date().toISOString(), // ✅ Added timestamp
    };
  }

  const finalTire = await this.prisma.tire.update({
    where: { id: tireId },
    data: updateData,
  });

  await this.notificationsService.deleteByTire(finalTire.id);

  return finalTire;
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

async updatePositions(placa: string, updates: { [position: string]: string | string[] }) {
  // Find the vehicle by placa
  const vehicle = await this.prisma.vehicle.findFirst({
    where: { placa }
  });
  if (!vehicle) {
    throw new BadRequestException('Vehicle not found for the given placa');
  }

  // First, reset all tires for this vehicle to unassigned (posicion = null)
  // This ensures we have a clean slate before applying new positions
  await this.prisma.tire.updateMany({
    where: { 
      vehicleId: vehicle.id,
      placa: placa 
    },
data: { posicion: 0 }
  });

  // Process all updates
  for (const pos in updates) {
    const tireIds = Array.isArray(updates[pos]) ? updates[pos] : [updates[pos]];
    
    for (const tireId of tireIds) {
      const tire = await this.prisma.tire.findUnique({ where: { id: tireId } });
      
      if (!tire) {
        throw new BadRequestException(`Tire with id ${tireId} not found`);
      }
      if (tire.vehicleId !== vehicle.id) {
        throw new BadRequestException(`Tire with id ${tireId} does not belong to vehicle with plate ${placa}`);
      }
      
      // Set the tire position
      const posicion = pos === '0' ? 0 : parseInt(pos, 10);
      await this.prisma.tire.update({
        where: { id: tireId },
        data: { posicion }
      });
    }
  }

  return { message: 'Positions updated successfully' };
}

async analyzeTires(vehiclePlaca: string) {
  const vehicle = await this.prisma.vehicle.findFirst({
    where: { placa: vehiclePlaca }
  });

  if (!vehicle) throw new BadRequestException(`Vehicle with placa ${vehiclePlaca} not found`);

  const tires = await this.prisma.tire.findMany({
    where: { vehicleId: vehicle.id }
  });

  if (!tires || tires.length === 0)
    throw new BadRequestException(`No tires found for vehicle with placa ${vehiclePlaca}`);

  const analysisResults = await Promise.all(tires.map(tire => this.analyzeTire(tire)));
  return { vehicle, tires: analysisResults };
}

private analyzeTire(tire: any) {
  if (!tire.inspecciones || !Array.isArray(tire.inspecciones) || tire.inspecciones.length === 0) {
    return {
      id: tire.id,
      posicion: tire.posicion,
      profundidadActual: null,
      inspecciones: [],
      recomendaciones: [
        "🔴 Inspección requerida: No se han registrado inspecciones. Realizar una evaluación inmediata."
      ]
    };
  }

  const lastInspections = [...tire.inspecciones]
    .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
    .slice(0, 3);
  const latest = lastInspections[0];

  const pInt = Number(latest.profundidadInt) || 0;
  const pCen = Number(latest.profundidadCen) || 0;
  const pExt = Number(latest.profundidadExt) || 0;
  const profundidadActual = (pInt + pCen + pExt) / 3;

  const presion = tire.presion?.[tire.presion.length - 1]?.value;
  const cpk = tire.cpk?.[tire.cpk.length - 1]?.value;
  const delta1 = Math.abs(pInt - pCen);
  const delta2 = Math.abs(pCen - pExt);
  const delta3 = Math.abs(pInt - pExt);

  let recomendacion = "";

  // Priority 1: Critical depth
  if (profundidadActual <= 2) {
    recomendacion = "🔴 Cambio inmediato: Desgaste crítico. Reemplazo urgente.";
  }
  // Priority 2: No depth issue, but uneven wear
  else if (delta1 > 3 || delta2 > 3 || delta3 > 3) {
    recomendacion = "🟡 Desgaste irregular: Diferencias notables entre zonas. Revisar alineación o presión.";
  }
  // Priority 3: Poor CPK
  else if (cpk && cpk < 5) {
    recomendacion = "🔴 CPK muy bajo: Alto costo por kilómetro. Evaluar desempeño de la llanta.";
  }
  // Priority 4: Under/Over inflation
  else if (presion != null && (presion < 100 || presion > 130)) {
    recomendacion = `🟡 Presión fuera de rango: Actual: ${presion} PSI. Ajustar conforme a especificación.`;
  }
  // Priority 5: Low but not critical depth
  else if (profundidadActual <= 4) {
    recomendacion = "🟡 Revisión frecuente: La profundidad está bajando. Monitorear en próximas inspecciones.";
  }
  // Priority 7: Everything fine
  else {
    recomendacion = "🟢 Buen estado: Sin hallazgos relevantes en esta inspección.";
  }

  return {
    id: tire.id,
    posicion: tire.posicion,
    profundidadActual,
    inspecciones: lastInspections,
    recomendaciones: [recomendacion],
    desechos: tire.desechos ?? null,
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

async findAllTires() {
    // Admin-only access, return all tires without filtering by company
    return await this.prisma.tire.findMany();
  }
  
}