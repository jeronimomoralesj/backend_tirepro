import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { PrismaService } from '../prisma/prisma.service';

// =============================================================================
// DTOs
// =============================================================================

export interface CreateBucketDto {
  companyId:       string;
  nombre:          string;
  color?:          string;
  icono?:          string;
  excluirDeFlota?: boolean;
  orden?:          number;
}

export interface UpdateBucketDto {
  nombre?:         string;
  color?:          string;
  icono?:          string;
  excluirDeFlota?: boolean;
  orden?:          number;
}

export interface MoveTireToBucketDto {
  tireId:   string;
  bucketId: string | null; // null = Disponible (no bucket)
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class InventoryBucketsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // ── Cache key helpers — mirrors TireService key scheme exactly ─────────────

  private tireCompanyKey(companyId: string): string {
    return `tires:${companyId}`;
  }

  private tireVehicleKey(vehicleId: string): string {
    return `tires:vehicle:${vehicleId}`;
  }

  private analysisKey(vehicleId: string): string {
    return `analysis:${vehicleId}`;
  }

  // ── Invalidate all caches touched by a tire mutation ──────────────────────
  // Pass every vehicleId that was affected (before AND after the mutation) so
  // both the old vehicle and any new assignment get cleared.

  private async invalidateTireCaches(
    companyId:  string,
    vehicleIds: Array<string | null | undefined>,
  ): Promise<void> {
    const keys: string[] = [
      this.tireCompanyKey(companyId),
      'tires:all',
      // Vehicle list carries _count.tires per vehicle on the dashboard.
      // Bucket moves and batch-returns change that count whenever a tire
      // gains or loses a vehicleId, so the list cache must drop too.
      `vehicles:${companyId}`,
    ];

    for (const vid of vehicleIds) {
      if (vid) {
        keys.push(this.tireVehicleKey(vid));
        keys.push(this.analysisKey(vid));
      }
    }

    await Promise.all(keys.map(k => this.cache.del(k)));
  }

  // "Disponible" is implicit (null bucket) and rendered by the frontend.
  // The Reencauche bucket is system-managed — exactly one per company,
  // identified by `tipo = 'reencauche'` (never by name, so renames don't
  // break the reencauche flow).
  private async ensureDefaultBuckets(companyId: string): Promise<void> {
    const reencauche = await this.prisma.tireInventoryBucket.findFirst({
      where:  { companyId, tipo: 'reencauche' },
      select: { id: true },
    });
    if (reencauche) return;

    await this.prisma.tireInventoryBucket.create({
      data: {
        companyId,
        nombre: 'Reencauche',
        color:  '#8b5cf6',
        icono:  '♻️',
        tipo:   'reencauche',
      },
    });
  }

  // Returns the company's system-managed Reencauche bucket, seeding it if
  // it doesn't yet exist. Other services (purchase-orders reencauche flow)
  // depend on this existing, so we never rely on the lazy seed in findAll.
  async getReencaucheBucket(companyId: string) {
    await this.ensureDefaultBuckets(companyId);
    const bucket = await this.prisma.tireInventoryBucket.findFirst({
      where: { companyId, tipo: 'reencauche' },
    });
    if (!bucket) {
      // Seed above guarantees existence; this is a defensive fallback.
      throw new NotFoundException('Reencauche bucket could not be created');
    }
    return bucket;
  }

  // ---------------------------------------------------------------------------
  // LIST — all buckets for a company + implicit Disponible count
  // ---------------------------------------------------------------------------
  async findAll(companyId: string) {
    // Lazily seed the default Reencauche bucket on first read per company.
    await this.ensureDefaultBuckets(companyId);

    const [buckets, disponibleCount] = await Promise.all([
      this.prisma.tireInventoryBucket.findMany({
        where:   { companyId },
        orderBy: [{ orden: 'asc' }, { createdAt: 'asc' }],
        include: { _count: { select: { tires: true } } },
      }),
      this.prisma.tire.count({
        where: {
          companyId,
          vehicleId:         null,
          inventoryBucketId: null,
          NOT: { vidaActual: 'fin' },
        },
      }),
    ]);

    return {
      disponible: disponibleCount,
      buckets: buckets.map(b => ({
        id:             b.id,
        nombre:         b.nombre,
        color:          b.color,
        icono:          b.icono,
        // Surface tipo so the UI can hide the delete/rename actions on
        // system-managed buckets (Reencauche). Defaults to null for
        // user-created buckets.
        tipo:           b.tipo ?? null,
        excluirDeFlota: b.excluirDeFlota,
        orden:          b.orden,
        tireCount:      b._count.tires,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // LIST TIRES — inside a specific bucket, or the implicit Disponible bucket
  // ---------------------------------------------------------------------------
  async findTiresInBucket(companyId: string, bucketId: string | 'disponible') {
    const where =
      bucketId === 'disponible'
        ? {
            companyId,
            vehicleId:         null as null,
            inventoryBucketId: null as null,
            NOT: { vidaActual: 'fin' as const },
          }
        : {
            companyId,
            inventoryBucketId: bucketId,
            NOT: { vidaActual: 'fin' as const },
          };

    return this.prisma.tire.findMany({
      where,
      include: {
        inspecciones:    { orderBy: { fecha: 'desc' }, take: 1 },
        costos:          { orderBy: { fecha: 'desc' }, take: 1 },
        inventoryBucket: { select: { nombre: true, color: true, icono: true } },
      },
      orderBy: { inventoryEnteredAt: 'desc' },
    });
  }

  // ---------------------------------------------------------------------------
  // CREATE
  // ---------------------------------------------------------------------------
  async create(dto: CreateBucketDto) {
    const exists = await this.prisma.tireInventoryBucket.findFirst({
      where: {
        companyId: dto.companyId,
        nombre:    { equals: dto.nombre.trim(), mode: 'insensitive' },
      },
    });
    if (exists) {
      throw new ConflictException(`Ya existe un inventario llamado "${dto.nombre}"`);
    }

    return this.prisma.tireInventoryBucket.create({
      data: {
        companyId:      dto.companyId,
        nombre:         dto.nombre.trim(),
        color:          dto.color          ?? '#1E76B6',
        icono:          dto.icono          ?? '📦',
        excluirDeFlota: dto.excluirDeFlota ?? false,
        orden:          dto.orden          ?? 0,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // UPDATE
  // ---------------------------------------------------------------------------
  async update(bucketId: string, companyId: string, dto: UpdateBucketDto) {
    const bucket = await this.prisma.tireInventoryBucket.findFirst({
      where: { id: bucketId, companyId },
    });
    if (!bucket) throw new NotFoundException('Bucket not found');

    // Reencauche bucket is system-managed; renaming or recoloring it would
    // break code paths that find it by name as a fallback when tipo is
    // missing. The name and emoji are locked even though companyId-level
    // ownership is correct.
    if (bucket.tipo === 'reencauche') {
      throw new BadRequestException(
        'El bucket de Reencauche es del sistema y no se puede modificar.',
      );
    }

    // Name uniqueness check (only when name is changing)
    if (dto.nombre && dto.nombre.trim().toLowerCase() !== bucket.nombre.toLowerCase()) {
      const conflict = await this.prisma.tireInventoryBucket.findFirst({
        where: {
          companyId,
          nombre: { equals: dto.nombre.trim(), mode: 'insensitive' },
          NOT:    { id: bucketId },
        },
      });
      if (conflict) {
        throw new ConflictException(`Ya existe un inventario llamado "${dto.nombre}"`);
      }
    }

    return this.prisma.tireInventoryBucket.update({
      where: { id: bucketId },
      data: {
        ...(dto.nombre         !== undefined && { nombre:         dto.nombre.trim()  }),
        ...(dto.color          !== undefined && { color:          dto.color          }),
        ...(dto.icono          !== undefined && { icono:          dto.icono          }),
        ...(dto.excluirDeFlota !== undefined && { excluirDeFlota: dto.excluirDeFlota }),
        ...(dto.orden          !== undefined && { orden:          dto.orden          }),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // DELETE — tires inside are moved to Disponible before deleting
  // ---------------------------------------------------------------------------
  async remove(bucketId: string, companyId: string) {
    const bucket = await this.prisma.tireInventoryBucket.findFirst({
      where: { id: bucketId, companyId },
    });
    if (!bucket) throw new NotFoundException('Bucket not found');

    // System-managed Reencauche bucket is undeletable — every company is
    // guaranteed to have one because the reencauche flow (purchase orders,
    // analista, inventory move-to-vehicle blocker resolution) all assume
    // it exists. Allowing delete would break those code paths silently.
    // Disponible is implicit (no row), so it has no delete vector.
    if (bucket.tipo === 'reencauche') {
      throw new BadRequestException(
        'El bucket de Reencauche es del sistema y no se puede eliminar.',
      );
    }

    // Move all tires in this bucket to Disponible first (FK safety)
    await this.prisma.tire.updateMany({
      where: { inventoryBucketId: bucketId },
      data:  { inventoryBucketId: null },
    });

    await this.prisma.tireInventoryBucket.delete({ where: { id: bucketId } });

    // Tires moved to Disponible are still off-vehicle — only company cache needs clearing.
    await this.invalidateTireCaches(companyId, []);

    return {
      message: `Inventario "${bucket.nombre}" eliminado. Sus llantas fueron movidas a Disponible.`,
    };
  }

  // ---------------------------------------------------------------------------
  // MOVE TIRE TO BUCKET (or back to Disponible)
  //
  // Rules:
  //  • Coming from a vehicle → snapshot lastVehicle fields + set inventoryEnteredAt
  //  • Moving between buckets → preserve lastVehicle, only update inventoryEnteredAt
  //  • Moving to Disponible (bucketId = null) → same rules as above
  // ---------------------------------------------------------------------------
  async moveTireToBucket(dto: MoveTireToBucketDto, companyId: string) {
    // Include vehicle so we can snapshot placa before detaching
    const tire = await this.prisma.tire.findFirst({
      where:   { id: dto.tireId, companyId },
      include: { vehicle: { select: { placa: true } } },
    });
    if (!tire) throw new NotFoundException('Tire not found');

    if (dto.bucketId !== null) {
      const bucket = await this.prisma.tireInventoryBucket.findFirst({
        where: { id: dto.bucketId, companyId },
      });
      if (!bucket) throw new NotFoundException('Bucket not found');
    }

    const now               = new Date();
    const comingFromVehicle = !!tire.vehicleId;
    // Capture the vehicle IDs we need to invalidate BEFORE the update clears them.
    const previousVehicleId = tire.vehicleId ?? null;
    const lastVehicleId     = tire.lastVehicleId ?? null;

    const updated = await this.prisma.tire.update({
      where: { id: dto.tireId },
      data: {
        vehicleId:          null,
        posicion:           0,
        inventoryBucketId:  dto.bucketId,
        inventoryEnteredAt: now,
        // Only overwrite lastVehicle when the tire is actually leaving a vehicle.
        // Moving between buckets keeps the original vehicle origin intact so
        // the return-to-vehicle feature still works.
        ...(comingFromVehicle && {
          lastVehicleId:    tire.vehicleId,
          lastVehiclePlaca: (tire as any).vehicle?.placa ?? null,
          lastPosicion:     tire.posicion ?? 0,
        }),
      },
      include: {
        inventoryBucket: { select: { nombre: true, color: true, icono: true } },
      },
    });

    // Invalidate: company list + any vehicle the tire was previously on.
    await this.invalidateTireCaches(companyId, [previousVehicleId, lastVehicleId]);

    return updated;
  }

  // ---------------------------------------------------------------------------
  // BULK MOVE — move multiple tires to a bucket at once
  // Does NOT snapshot lastVehicle (use moveTireToBucket for that precision).
  // Intended for admin bulk operations where origin doesn't matter.
  // ---------------------------------------------------------------------------
  async bulkMoveTiresToBucket(
    tireIds:   string[],
    bucketId:  string | null,
    companyId: string,
  ) {
    if (!tireIds.length) throw new BadRequestException('tireIds must not be empty');

    if (bucketId !== null) {
      const bucket = await this.prisma.tireInventoryBucket.findFirst({
        where: { id: bucketId, companyId },
      });
      if (!bucket) throw new NotFoundException('Bucket not found');
    }

    // Collect vehicleIds before mutation so we can invalidate them.
    const affectedTires = await this.prisma.tire.findMany({
      where:  { id: { in: tireIds }, companyId },
      select: { vehicleId: true, lastVehicleId: true },
    });

    const result = await this.prisma.tire.updateMany({
      where: { id: { in: tireIds }, companyId },
      data: {
        vehicleId:          null,
        posicion:           0,
        inventoryBucketId:  bucketId,
        inventoryEnteredAt: new Date(),
      },
    });

    const vehicleIds = affectedTires.flatMap(t => [t.vehicleId, t.lastVehicleId]);
    await this.invalidateTireCaches(companyId, vehicleIds);

    return { updated: result.count };
  }

  // ---------------------------------------------------------------------------
  // BATCH RETURN TO VEHICLES
  //
  // Called by the Inventarios page after the user resolves conflicts.
  //
  // `returns`        — tires with a confirmed target vehicle + position
  // `fallbackTireIds`— tires the user chose to send to Disponible instead
  //                    (conflict resolution: position was occupied and user
  //                     did not want to force it)
  //
  // After a successful return all inventory tracking fields are cleared so the
  // tire is treated as a normal active tire again.
  // ---------------------------------------------------------------------------
  async batchReturnToVehicles(
    returns:         Array<{ tireId: string; vehicleId: string; posicion: number }>,
    fallbackTireIds: string[],
    companyId:       string,
  ) {
    if (!returns.length && !fallbackTireIds.length) {
      throw new BadRequestException('Nothing to process');
    }

    // Validate all target vehicles belong to this company
    if (returns.length) {
      const vehicleIds  = [...new Set(returns.map(r => r.vehicleId))];
      const validCount  = await this.prisma.vehicle.count({
        where: { id: { in: vehicleIds }, companyId },
      });
      if (validCount !== vehicleIds.length) {
        throw new BadRequestException('One or more target vehicles do not belong to this company');
      }
    }

    // Collect lastVehicleIds for fallback tires so we can invalidate those too.
    const fallbackTires = fallbackTireIds.length
      ? await this.prisma.tire.findMany({
          where:  { id: { in: fallbackTireIds } },
          select: { lastVehicleId: true },
        })
      : [];

    await this.prisma.$transaction([
      // Confirmed returns — assign back to vehicle and wipe inventory fields
      ...returns.map(({ tireId, vehicleId, posicion }) =>
        this.prisma.tire.update({
          where: { id: tireId },
          data: {
            vehicleId,
            posicion,
            inventoryBucketId:  null,
            lastVehicleId:      null,
            lastVehiclePlaca:   null,
            lastPosicion:       null,
            inventoryEnteredAt: null,
          },
        }),
      ),
      // Fallback — move conflicted tires to Disponible (no bucket, no vehicle)
      ...(fallbackTireIds.length
        ? [
            this.prisma.tire.updateMany({
              where: { id: { in: fallbackTireIds }, companyId },
              data: {
                vehicleId:          null,
                posicion:           0,
                inventoryBucketId:  null,
                inventoryEnteredAt: new Date(),
              },
            }),
          ]
        : []),
    ]);

    // Build the full set of vehicleIds to invalidate:
    //  • vehicles the tires are returning TO
    //  • vehicles fallback tires previously came FROM (lastVehicleId)
    const returnVehicleIds  = returns.map(r => r.vehicleId);
    const fallbackVehicleIds = fallbackTires.map(t => t.lastVehicleId);
    const allVehicleIds      = [...returnVehicleIds, ...fallbackVehicleIds];

    await this.invalidateTireCaches(companyId, allVehicleIds);

    return {
      returned:          returns.length,
      movedToDisponible: fallbackTireIds.length,
    };
  }
}