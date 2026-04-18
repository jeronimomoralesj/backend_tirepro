import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CompanyPlan } from '@prisma/client';
import { S3Service } from './s3.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

const DEFAULT_LOGO =
  'https://tireproimages.s3.us-east-1.amazonaws.com/companyResources/logoFull.png';

const COMPANY_PUBLIC_SELECT = {
  id:           true,
  name:         true,
  plan:         true,
  profileImage: true,
} as const;

const COMPANY_TTL = 60 * 60 * 1000;

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  private companyKey(companyId: string) {
    return `company:${companyId}`;
  }

  private async invalidateCompanyCache(companyId: string) {
    await this.cache.del(this.companyKey(companyId));
  }

  // ── Logo ──────────────────────────────────────────────────────────────────

  async updateCompanyLogo(companyId: string, imageBase64: string) {
    if (!imageBase64?.startsWith('data:image')) {
      throw new BadRequestException('Invalid image format');
    }

    const base64Data = imageBase64.split(',')[1];
    if (!base64Data) {
      throw new BadRequestException('Invalid base64 payload');
    }

    const company = await this.prisma.company.findUnique({
      where:  { id: companyId },
      select: { id: true },
    });
    if (!company) throw new NotFoundException('Company not found');

    const mimeMatch   = imageBase64.match(/^data:(image\/\w+);base64,/);
    const contentType = mimeMatch?.[1] ?? 'image/jpeg';
    const buffer      = Buffer.from(base64Data, 'base64');
    const imageUrl    = await this.s3.uploadCompanyLogo(buffer, companyId, contentType);

    await this.prisma.company.update({
      where: { id: companyId },
      data:  { profileImage: imageUrl },
    });

    await this.invalidateCompanyCache(companyId); // ← added: logo changed, cached company is stale
    return { message: 'Logo actualizado correctamente', profileImage: imageUrl };
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createCompany(dto: CreateCompanyDto) {
    const company = await this.prisma.company.create({
      data: {
        name:         dto.name,
        plan:         (dto.plan as CompanyPlan) ?? CompanyPlan.basic,
        profileImage: DEFAULT_LOGO,
        ...(dto.emailAtencion && { emailAtencion: dto.emailAtencion }),
      },
    });

    // No cache to invalidate on create — the key doesn't exist yet
    return { message: 'Company registered successfully', companyId: company.id };
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async getCompanyById(companyId: string) {
    const cached = await this.cache.get(this.companyKey(companyId));
    if (cached) return cached; // ← added: serve from cache on subsequent reads

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        distributors: {
          include: {
            distributor: { select: COMPANY_PUBLIC_SELECT },
          },
        },
        _count: {
          select: { users: true, tires: true, vehicles: true },
        },
      },
    });

    if (!company) throw new NotFoundException('Company not found');

    await this.cache.set(this.companyKey(companyId), company, COMPANY_TTL); // ← added
    return company;
  }

  async getAllCompanies() {
    // Not cached — this is an admin-only list, called rarely, and spans all companies
    return this.prisma.company.findMany({
      select: {
        ...COMPANY_PUBLIC_SELECT,
        createdAt: true,
        updatedAt: true,
        _count: { select: { users: true, tires: true, vehicles: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async searchCompaniesByName(
    query: string,
    excludeCompanyId?: string,
    distributorsOnly = false,
  ) {
    if (!query || query.trim().length < 2) return [];

    // Not cached — search results depend on arbitrary query strings, not worth caching
    return this.prisma.company.findMany({
      where: {
        name: { contains: query.trim(), mode: 'insensitive' },
        ...(excludeCompanyId && { id: { not: excludeCompanyId } }),
        ...(distributorsOnly && { plan: 'distribuidor' }),
      },
      select:  COMPANY_PUBLIC_SELECT,
      take:    10,
      orderBy: { name: 'asc' },
    });
  }

  // ── Distributor access ────────────────────────────────────────────────────

  async getConnectedDistributors(companyId: string) {
    // Not cached — called infrequently, low value to cache
    return this.prisma.distributorAccess.findMany({
      where:   { companyId },
      include: { distributor: { select: COMPANY_PUBLIC_SELECT } },
    });
  }

  async getClientsForDistributor(distributorCompanyId: string) {
    const cacheKey = `dist-clients:${distributorCompanyId}`;
    const cached   = await this.cache.get(cacheKey);
    if (cached) return cached;

    // Step 1: basic company + counts (users, vehicles, tires).
    const access = await this.prisma.distributorAccess.findMany({
      where:   { distributorId: distributorCompanyId },
      include: {
        company: {
          select: {
            ...COMPANY_PUBLIC_SELECT,
            createdAt: true,
            _count:   { select: { vehicles: true, tires: true, users: true } },
          },
        },
      },
    });
    if (access.length === 0) return [];

    const companyIds = access.map(a => a.companyId);

    // Step 2: one aggregate per metric, each a single indexed query. Using
    // raw SQL here because Prisma's groupBy won't compose MAX + AVG + FILTER
    // in one go, and we'd rather do 2 queries than 6.
    const [tireAgg, costAgg] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{
        companyId:        string;
        active_tires:     number;
        fin_tires:        number;
        last_inspection:  Date | null;
        avg_cpk:          string | null;  // numeric → string in pg driver
      }>>(`
        SELECT "companyId",
               COUNT(*) FILTER (WHERE "vidaActual" <> 'fin')::int AS active_tires,
               COUNT(*) FILTER (WHERE "vidaActual"  = 'fin')::int AS fin_tires,
               MAX("lastInspeccionDate")                          AS last_inspection,
               AVG("currentCpk") FILTER (WHERE "currentCpk" > 0)  AS avg_cpk
        FROM "Tire"
        WHERE "companyId" = ANY($1::text[])
        GROUP BY "companyId"
      `, companyIds),

      this.prisma.$queryRawUnsafe<Array<{
        companyId: string;
        inversion: string | null;
      }>>(`
        SELECT t."companyId",
               SUM(c.valor)::bigint AS inversion
        FROM "Tire" t
        JOIN tire_costos c ON c."tireId" = t.id
        WHERE t."companyId" = ANY($1::text[])
        GROUP BY t."companyId"
      `, companyIds),
    ]);

    const tireByCo = new Map(tireAgg.map(r => [r.companyId, r]));
    const costByCo = new Map(costAgg.map(r => [r.companyId, r]));

    // Step 3: merge + return a shape the frontend can render directly.
    const now = Date.now();
    const result = access.map(a => {
      const co       = a.company;
      const tire     = tireByCo.get(a.companyId);
      const cost     = costByCo.get(a.companyId);
      const activeTires = tire?.active_tires ?? 0;
      const finTires    = tire?.fin_tires ?? 0;
      const avgCpk      = tire?.avg_cpk != null ? parseFloat(tire.avg_cpk) : null;
      const inversion   = cost?.inversion != null ? Number(cost.inversion) : 0;
      const companySince     = co.createdAt;
      const distributorSince = a.createdAt;
      const yearsClient      = Math.floor(
        (now - new Date(distributorSince).getTime()) / (365.25 * 24 * 3600 * 1000),
      );
      return {
        ...a,
        company: {
          ...co,
          // Stats the distributor panel displays in the client list + header
          stats: {
            users:           co._count.users,
            vehicles:        co._count.vehicles,
            tires:           co._count.tires,
            activeTires,
            finTires,
            lastInspection:  tire?.last_inspection ?? null,
            avgCpk,
            inversionTotal:  inversion,
            clientSince:     companySince,
            distributorSince,
            yearsAsClient:   yearsClient,
          },
        },
      };
    });

    // 10-min cache — enrichment is expensive but invalidates on any tire /
    // user edit via invalidateCompanyCache (we don't wire that yet for
    // distributor rollups; they'll refresh every 10 min regardless).
    await this.cache.set(cacheKey, result, 10 * 60 * 1000);
    return result;
  }

  async grantDistributorAccess(companyId: string, distributorId: string) {
    if (companyId === distributorId) {
      throw new BadRequestException('A company cannot be its own distributor');
    }

    const [company, distributor] = await Promise.all([
      this.prisma.company.findUnique({
        where:  { id: companyId },
        select: { id: true },
      }),
      this.prisma.company.findUnique({
        where:  { id: distributorId },
        select: { id: true, plan: true },
      }),
    ]);

    if (!company)     throw new NotFoundException('Company not found');
    if (!distributor) throw new NotFoundException('Distributor not found');
    if (distributor.plan !== CompanyPlan.distribuidor) {
      throw new BadRequestException('Selected company is not a distributor');
    }

    const result = await this.prisma.distributorAccess.upsert({
      where:  { companyId_distributorId: { companyId, distributorId } },
      create: { companyId, distributorId },
      update: {},
    });

    // Both companies' cached records now have stale distributor lists
    await Promise.all([
      this.invalidateCompanyCache(companyId),     // ← added
      this.invalidateCompanyCache(distributorId), // ← added
    ]);
    return result;
  }

  async revokeDistributorAccess(companyId: string, distributorId: string) {
    const existing = await this.prisma.distributorAccess.findUnique({
      where: { companyId_distributorId: { companyId, distributorId } },
    });
    if (!existing) throw new NotFoundException('Distributor access not found');

    const result = await this.prisma.distributorAccess.delete({
      where: { companyId_distributorId: { companyId, distributorId } },
    });

    // Same reason as grant — both cached records are now stale
    await Promise.all([
      this.invalidateCompanyCache(companyId),
      this.invalidateCompanyCache(distributorId),
    ]);
    return result;
  }

  // ── Agent settings & email ───────────────────────────────────────────────

  async updateAgentSettings(companyId: string, settings: Record<string, any>) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) throw new NotFoundException('Company not found');

    const updated = await this.prisma.company.update({
      where: { id: companyId },
      data: { agentSettings: settings },
    });

    await this.invalidateCompanyCache(companyId);
    return updated;
  }

  async updateEmailAtencion(companyId: string, email: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) throw new NotFoundException('Company not found');

    const updated = await this.prisma.company.update({
      where: { id: companyId },
      data: { emailAtencion: email },
    });

    await this.invalidateCompanyCache(companyId);
    return updated;
  }

  async getAgentSettings(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { agentSettings: true, emailAtencion: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async deleteCompany(companyId: string) {
  const company = await this.prisma.company.findUnique({
    where:  { id: companyId },
    select: { id: true, _count: { select: { tires: true, vehicles: true, users: true } } },
  });
  if (!company) throw new NotFoundException('Company not found');

  // Safety check — refuse to delete if it still owns data
  const { tires, vehicles, users } = company._count;
  if (tires > 0 || vehicles > 0 || users > 0) {
    throw new BadRequestException(
      `Company still has ${tires} tires, ${vehicles} vehicles, ${users} users. ` +
      `Reassign all data before deleting.`
    );
  }

  await this.prisma.company.delete({ where: { id: companyId } });
  await this.invalidateCompanyCache(companyId);
  return { message: 'Company deleted successfully' };
}
}