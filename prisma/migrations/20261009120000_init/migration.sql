-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CHECKING',
    "institution" TEXT,
    "notes" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "subtype" TEXT
);

-- CreateTable
CREATE TABLE "AccountAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'FIRST_SEEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountAlias_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fileHash" TEXT NOT NULL,
    "contentFingerprint" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "originalFileName" TEXT,
    "institution" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "parserId" TEXT NOT NULL,
    "parserVersion" INTEGER NOT NULL,
    "periodStart" DATETIME,
    "periodEnd" DATETIME,
    "warningsJson" JSONB,
    "factsVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "StatementImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "statementType" TEXT NOT NULL,
    "isSummary" BOOLEAN NOT NULL DEFAULT false,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "openingBalanceCents" INTEGER NOT NULL,
    "closingBalanceCents" INTEGER NOT NULL,
    "growthCents" INTEGER NOT NULL DEFAULT 0,
    "feesCents" INTEGER NOT NULL DEFAULT 0,
    "reconciliationDeltaCents" INTEGER NOT NULL DEFAULT 0,
    "checksJson" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StatementImport_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StatementImport_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SourceDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PayStub" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "employee" TEXT NOT NULL,
    "employer" TEXT NOT NULL,
    "employerKey" TEXT NOT NULL,
    "payDate" DATETIME NOT NULL,
    "periodStart" DATETIME,
    "periodEnd" DATETIME,
    "federalFilingStatus" TEXT,
    "grossCurrentCents" INTEGER,
    "grossYtdCents" INTEGER,
    "withheldCurrentCents" INTEGER,
    "withheldYtdCents" INTEGER,
    "netPayCents" INTEGER NOT NULL,
    "netYtdCents" INTEGER,
    "depositsJson" JSONB NOT NULL,
    "warningsJson" JSONB,
    "depositTransactionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayStub_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SourceDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PayStub_depositTransactionId_fkey" FOREIGN KEY ("depositTransactionId") REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PayStubLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "payStubId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "currentCents" INTEGER,
    "ytdCents" INTEGER,
    CONSTRAINT "PayStubLine_payStubId_fkey" FOREIGN KEY ("payStubId") REFERENCES "PayStub" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BrokerageTaxFacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "isYearEnd" BOOLEAN NOT NULL,
    "kind" TEXT NOT NULL,
    "ownerLine" TEXT NOT NULL,
    "isChet" BOOLEAN NOT NULL DEFAULT false,
    "endingValueCents" INTEGER,
    "contributionsYtdCents" INTEGER,
    "incomeJson" JSONB,
    "realizedJson" JSONB,
    "incomeRowsJson" JSONB NOT NULL,
    "distributionsJson" JSONB NOT NULL,
    CONSTRAINT "BrokerageTaxFacts_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SourceDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HoldingSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "asOf" DATETIME NOT NULL,
    "positionsJson" JSONB NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "printedTotalCents" INTEGER,
    CONSTRAINT "HoldingSnapshot_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SourceDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TransferMatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "differenceCents" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TransferLeg" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    CONSTRAINT "TransferLeg_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "TransferMatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TransferLeg_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TransferRejection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "legKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "groupName" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'EXPENSE',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MerchantCategoryRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "matchPattern" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "lane" TEXT,
    "source" TEXT NOT NULL DEFAULT 'USER',
    "timesApplied" INTEGER NOT NULL DEFAULT 0,
    "lastAppliedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MerchantCategoryRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "payee" TEXT,
    "memo" TEXT,
    "accountId" TEXT NOT NULL,
    "categoryId" TEXT,
    "transferGroupId" TEXT,
    "lane" TEXT,
    "statementImportId" TEXT,
    "datePrecision" TEXT NOT NULL DEFAULT 'EXACT',
    "section" TEXT,
    "detail" TEXT,
    "cardMember" TEXT,
    "merchantKey" TEXT,
    "counterpartyKind" TEXT,
    "counterpartyInstitution" TEXT,
    "counterpartyAccountHint" TEXT,
    "counterpartySubtypes" TEXT,
    "classifiedBy" TEXT,
    "confidence" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "userLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_statementImportId_fkey" FOREIGN KEY ("statementImportId") REFERENCES "StatementImport" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BudgetLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BudgetLine_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "payloadJson" JSONB,
    "correlationId" TEXT
);

-- CreateIndex
CREATE INDEX "AccountAlias_accountId_idx" ON "AccountAlias"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountAlias_institution_identifier_key" ON "AccountAlias"("institution", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_fileHash_key" ON "SourceDocument"("fileHash");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_contentFingerprint_key" ON "SourceDocument"("contentFingerprint");

-- CreateIndex
CREATE INDEX "SourceDocument_institution_periodEnd_idx" ON "SourceDocument"("institution", "periodEnd");

-- CreateIndex
CREATE INDEX "StatementImport_accountId_periodStart_idx" ON "StatementImport"("accountId", "periodStart");

-- CreateIndex
CREATE INDEX "StatementImport_documentId_idx" ON "StatementImport"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementImport_accountId_periodStart_periodEnd_isSummary_key" ON "StatementImport"("accountId", "periodStart", "periodEnd", "isSummary");

-- CreateIndex
CREATE UNIQUE INDEX "PayStub_depositTransactionId_key" ON "PayStub"("depositTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "PayStub_employerKey_payDate_netPayCents_key" ON "PayStub"("employerKey", "payDate", "netPayCents");

-- CreateIndex
CREATE INDEX "PayStubLine_payStubId_idx" ON "PayStubLine"("payStubId");

-- CreateIndex
CREATE INDEX "BrokerageTaxFacts_accountNumber_periodEnd_idx" ON "BrokerageTaxFacts"("accountNumber", "periodEnd");

-- CreateIndex
CREATE INDEX "BrokerageTaxFacts_documentId_idx" ON "BrokerageTaxFacts"("documentId");

-- CreateIndex
CREATE INDEX "HoldingSnapshot_accountNumber_asOf_idx" ON "HoldingSnapshot"("accountNumber", "asOf");

-- CreateIndex
CREATE INDEX "HoldingSnapshot_documentId_idx" ON "HoldingSnapshot"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "TransferLeg_transactionId_key" ON "TransferLeg"("transactionId");

-- CreateIndex
CREATE INDEX "TransferLeg_matchId_idx" ON "TransferLeg"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "TransferRejection_legKey_key" ON "TransferRejection"("legKey");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantCategoryRule_matchPattern_key" ON "MerchantCategoryRule"("matchPattern");

-- CreateIndex
CREATE INDEX "Transaction_accountId_date_idx" ON "Transaction"("accountId", "date");

-- CreateIndex
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");

-- CreateIndex
CREATE INDEX "Transaction_categoryId_idx" ON "Transaction"("categoryId");

-- CreateIndex
CREATE INDEX "Transaction_statementImportId_idx" ON "Transaction"("statementImportId");

-- CreateIndex
CREATE INDEX "Transaction_lane_date_idx" ON "Transaction"("lane", "date");

-- CreateIndex
CREATE INDEX "Transaction_needsReview_idx" ON "Transaction"("needsReview");

-- CreateIndex
CREATE INDEX "BudgetLine_year_month_idx" ON "BudgetLine"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLine_year_month_categoryId_key" ON "BudgetLine"("year", "month", "categoryId");

-- CreateIndex
CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");

