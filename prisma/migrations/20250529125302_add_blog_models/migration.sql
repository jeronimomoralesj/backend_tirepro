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
