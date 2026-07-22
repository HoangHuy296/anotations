-- Registration now supplies an explicitly validated system role.
-- Existing users retain their current role values.
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
