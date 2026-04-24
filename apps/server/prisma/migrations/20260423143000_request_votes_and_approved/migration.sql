-- AlterTable
ALTER TABLE "SongRequest"
ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'queued';

-- RequestVote table
CREATE TABLE IF NOT EXISTS "RequestVote" (
    "id" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "guestToken" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestVote_pkey" PRIMARY KEY ("id")
);

-- Approve status is now part of the active queue lifecycle.
ALTER TABLE "SongRequest" DROP CONSTRAINT IF EXISTS "SongRequest_status_check";
ALTER TABLE "SongRequest"
  ADD CONSTRAINT "SongRequest_status_check"
  CHECK ("status" IN ('queued', 'approved', 'played', 'rejected'));

ALTER TABLE "RequestVote" DROP CONSTRAINT IF EXISTS "RequestVote_value_check";
ALTER TABLE "RequestVote"
  ADD CONSTRAINT "RequestVote_value_check"
  CHECK ("value" IN (-1, 1));

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RequestVote_requestId_guestToken_key" ON "RequestVote"("requestId", "guestToken");
CREATE INDEX IF NOT EXISTS "RequestVote_partyId_requestId_idx" ON "RequestVote"("partyId", "requestId");
CREATE INDEX IF NOT EXISTS "RequestVote_requestId_value_idx" ON "RequestVote"("requestId", "value");

-- AddForeignKey
ALTER TABLE "RequestVote"
  ADD CONSTRAINT "RequestVote_partyId_fkey"
  FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RequestVote"
  ADD CONSTRAINT "RequestVote_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "SongRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
