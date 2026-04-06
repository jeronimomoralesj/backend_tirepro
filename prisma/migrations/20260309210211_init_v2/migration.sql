-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'viewer', 'technician');

-- CreateEnum
CREATE TYPE "CompanyPlan" AS ENUM ('basic', 'pro', 'enterprise');

-- CreateEnum
CREATE TYPE "TireAlertLevel" AS ENUM ('ok', 'watch', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "EjeType" AS ENUM ('direccion', 'traccion', 'libre', 'remolque', 'repuesto');

-- CreateEnum
CREATE TYPE "TireEventType" AS ENUM ('montaje', 'rotacion', 'reparacion', 'retiro', 'inspeccion', 'reencauche');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "CouponCategory" AS ENUM ('llantas', 'reencauches', 'baterias', 'gasolina', 'aceites');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'admin',
    "puntos" INTEGER NOT NULL DEFAULT 0,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verificationToken" TEXT,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'es',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_vehicle_access" (
    "userId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,

    CONSTRAINT "user_vehicle_access_pkey" PRIMARY KEY ("userId","vehicleId")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "periodicity" INTEGER NOT NULL DEFAULT 1,
    "profileImage" TEXT NOT NULL DEFAULT 'https://tireproimages.s3.us-east-1.amazonaws.com/companyResources/logoFull.png',
    "plan" "CompanyPlan" NOT NULL DEFAULT 'basic',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributorAccess" (
    "companyId" TEXT NOT NULL,
    "distributorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistributorAccess_pkey" PRIMARY KEY ("companyId","distributorId")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "placa" TEXT NOT NULL,
    "kilometrajeActual" INTEGER NOT NULL DEFAULT 0,
    "carga" TEXT NOT NULL,
    "pesoCarga" DOUBLE PRECISION NOT NULL,
    "tipovhc" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "cliente" TEXT,
    "union" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tire" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "placa" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "diseno" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "eje" "EjeType" NOT NULL,
    "posicion" INTEGER NOT NULL DEFAULT 0,
    "profundidadInicial" DOUBLE PRECISION NOT NULL,
    "fechaInstalacion" TIMESTAMP(3),
    "diasAcumulados" INTEGER NOT NULL DEFAULT 0,
    "kilometrosRecorridos" INTEGER NOT NULL DEFAULT 0,
    "currentCpk" DOUBLE PRECISION,
    "currentCpt" DOUBLE PRECISION,
    "currentProfundidad" DOUBLE PRECISION,
    "cpkTrend" DOUBLE PRECISION,
    "projectedKmRemaining" INTEGER,
    "projectedDateEOL" TIMESTAMP(3),
    "healthScore" INTEGER,
    "alertLevel" "TireAlertLevel" NOT NULL DEFAULT 'ok',
    "lastInspeccionDate" TIMESTAMP(3),
    "primeraVida" JSONB NOT NULL DEFAULT '[]',
    "desechos" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspecciones" (
    "id" TEXT NOT NULL,
    "tireId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "profundidadInt" DOUBLE PRECISION NOT NULL,
    "profundidadCen" DOUBLE PRECISION NOT NULL,
    "profundidadExt" DOUBLE PRECISION NOT NULL,
    "cpk" DOUBLE PRECISION,
    "cpkProyectado" DOUBLE PRECISION,
    "cpt" DOUBLE PRECISION,
    "cptProyectado" DOUBLE PRECISION,
    "diasEnUso" INTEGER,
    "mesesEnUso" DOUBLE PRECISION,
    "kilometrosEstimados" INTEGER,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspecciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tire_eventos" (
    "id" TEXT NOT NULL,
    "tireId" TEXT NOT NULL,
    "tipo" "TireEventType" NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "notas" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tire_eventos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tire_costos" (
    "id" TEXT NOT NULL,
    "tireId" TEXT NOT NULL,
    "valor" DOUBLE PRECISION NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tire_costos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_snapshots" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "totalTires" INTEGER NOT NULL,
    "tiresOk" INTEGER NOT NULL,
    "tiresWatch" INTEGER NOT NULL,
    "tiresWarning" INTEGER NOT NULL,
    "tiresCritical" INTEGER NOT NULL,
    "avgHealthScore" DOUBLE PRECISION,
    "avgCpk" DOUBLE PRECISION,
    "medianCpk" DOUBLE PRECISION,
    "avgCpt" DOUBLE PRECISION,
    "stddevCpk" DOUBLE PRECISION,
    "totalFleetCost" DOUBLE PRECISION,
    "projectedMonthlyCost" DOUBLE PRECISION,
    "avgCostPerVehicle" DOUBLE PRECISION,
    "bestBrand" TEXT,
    "worstBrand" TEXT,
    "bestDiseno" TEXT,
    "avgKmPerTire" DOUBLE PRECISION,
    "totalVehicles" INTEGER NOT NULL,
    "activeUsers" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "seen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tireId" TEXT,
    "vehicleId" TEXT,
    "companyId" TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extras" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "articles" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "coverImage" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_passwords" (
    "id" SERIAL NOT NULL,
    "password" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "admin_passwords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_passwords" (
    "id" SERIAL NOT NULL,
    "password" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isUsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blog_passwords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "titleKey" TEXT NOT NULL,
    "descriptionKey" TEXT NOT NULL,
    "discount" TEXT NOT NULL,
    "category" "CouponCategory" NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Income" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Income_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_companyId_idx" ON "User"("companyId");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "user_vehicle_access_userId_idx" ON "user_vehicle_access"("userId");

-- CreateIndex
CREATE INDEX "user_vehicle_access_vehicleId_idx" ON "user_vehicle_access"("vehicleId");

-- CreateIndex
CREATE INDEX "DistributorAccess_distributorId_idx" ON "DistributorAccess"("distributorId");

-- CreateIndex
CREATE INDEX "Vehicle_companyId_idx" ON "Vehicle"("companyId");

-- CreateIndex
CREATE INDEX "Vehicle_placa_idx" ON "Vehicle"("placa");

-- CreateIndex
CREATE INDEX "Tire_companyId_idx" ON "Tire"("companyId");

-- CreateIndex
CREATE INDEX "Tire_vehicleId_idx" ON "Tire"("vehicleId");

-- CreateIndex
CREATE INDEX "Tire_marca_dimension_idx" ON "Tire"("marca", "dimension");

-- CreateIndex
CREATE INDEX "Tire_alertLevel_idx" ON "Tire"("alertLevel");

-- CreateIndex
CREATE INDEX "Tire_companyId_alertLevel_idx" ON "Tire"("companyId", "alertLevel");

-- CreateIndex
CREATE INDEX "Tire_companyId_lastInspeccionDate_idx" ON "Tire"("companyId", "lastInspeccionDate");

-- CreateIndex
CREATE INDEX "inspecciones_tireId_idx" ON "inspecciones"("tireId");

-- CreateIndex
CREATE INDEX "inspecciones_fecha_idx" ON "inspecciones"("fecha");

-- CreateIndex
CREATE INDEX "inspecciones_cpk_idx" ON "inspecciones"("cpk");

-- CreateIndex
CREATE INDEX "inspecciones_tireId_fecha_idx" ON "inspecciones"("tireId", "fecha");

-- CreateIndex
CREATE INDEX "inspecciones_tireId_createdAt_idx" ON "inspecciones"("tireId", "createdAt");

-- CreateIndex
CREATE INDEX "tire_eventos_tireId_fecha_idx" ON "tire_eventos"("tireId", "fecha");

-- CreateIndex
CREATE INDEX "tire_eventos_tipo_idx" ON "tire_eventos"("tipo");

-- CreateIndex
CREATE INDEX "tire_costos_tireId_fecha_idx" ON "tire_costos"("tireId", "fecha");

-- CreateIndex
CREATE INDEX "company_snapshots_companyId_fecha_idx" ON "company_snapshots"("companyId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "company_snapshots_companyId_fecha_key" ON "company_snapshots"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "Notification_companyId_idx" ON "Notification"("companyId");

-- CreateIndex
CREATE INDEX "Notification_companyId_seen_idx" ON "Notification"("companyId", "seen");

-- CreateIndex
CREATE INDEX "Notification_vehicleId_idx" ON "Notification"("vehicleId");

-- CreateIndex
CREATE INDEX "Notification_tireId_idx" ON "Notification"("tireId");

-- CreateIndex
CREATE INDEX "extras_vehicleId_idx" ON "extras"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "articles_slug_key" ON "articles"("slug");

-- CreateIndex
CREATE INDEX "articles_category_idx" ON "articles"("category");

-- CreateIndex
CREATE INDEX "articles_slug_idx" ON "articles"("slug");

-- CreateIndex
CREATE INDEX "Message_chatId_createdAt_idx" ON "Message"("chatId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "coupons_category_idx" ON "coupons"("category");

-- CreateIndex
CREATE INDEX "coupons_validUntil_idx" ON "coupons"("validUntil");

-- CreateIndex
CREATE INDEX "Income_userId_date_idx" ON "Income"("userId", "date");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_vehicle_access" ADD CONSTRAINT "user_vehicle_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_vehicle_access" ADD CONSTRAINT "user_vehicle_access_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributorAccess" ADD CONSTRAINT "DistributorAccess_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributorAccess" ADD CONSTRAINT "DistributorAccess_distributorId_fkey" FOREIGN KEY ("distributorId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tire" ADD CONSTRAINT "Tire_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tire" ADD CONSTRAINT "Tire_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspecciones" ADD CONSTRAINT "inspecciones_tireId_fkey" FOREIGN KEY ("tireId") REFERENCES "Tire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tire_eventos" ADD CONSTRAINT "tire_eventos_tireId_fkey" FOREIGN KEY ("tireId") REFERENCES "Tire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tire_costos" ADD CONSTRAINT "tire_costos_tireId_fkey" FOREIGN KEY ("tireId") REFERENCES "Tire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_snapshots" ADD CONSTRAINT "company_snapshots_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tireId_fkey" FOREIGN KEY ("tireId") REFERENCES "Tire"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extras" ADD CONSTRAINT "extras_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Income" ADD CONSTRAINT "Income_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
