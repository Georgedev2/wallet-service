-- BVN (Bank Verification Number) on the user. Optional at signup, stored normalised
-- (11 digits). A BVN identifies one person, so it can belong to only one account.
ALTER TABLE users
  ADD COLUMN bvn TEXT CHECK (bvn ~ '^[0-9]{11}$');

-- NULLs don't conflict, so any number of users can have no BVN.
CREATE UNIQUE INDEX users_bvn_uq ON users (bvn);
