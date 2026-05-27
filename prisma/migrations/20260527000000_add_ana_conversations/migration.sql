-- CreateTable
CREATE TABLE "ana_conversations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Nueva conversación',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ana_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ana_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "blocks" JSONB,
    "suggestions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ana_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ana_conversations_companyId_userId_updatedAt_idx" ON "ana_conversations"("companyId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ana_messages_conversationId_createdAt_idx" ON "ana_messages"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "ana_conversations" ADD CONSTRAINT "ana_conversations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ana_conversations" ADD CONSTRAINT "ana_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ana_messages" ADD CONSTRAINT "ana_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ana_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
