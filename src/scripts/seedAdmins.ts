import bcrypt from "bcryptjs";
import { connectDB } from "../config/db";
import { Admin } from "../models/Admin";

const SALT_ROUNDS = 12;

interface SeedAdmin {
  name: string;
  email: string;
  password: string;
}

const admins: SeedAdmin[] = [
  {
    name: "Haseeb",
    email: "haseeb@purely.com",
    password: "1111111111",
  },
  {
    name: "Amish",
    email: "amish@purely.com",
    password: "1111111111",
  },
  {
    name: "Ali",
    email: "ali@purely.com",
    password: "1111111111",
  },
];

async function seed(): Promise<void> {
  await connectDB();

  let created = 0;
  let updated = 0;

  for (const candidate of admins) {
    const hashedPassword = await bcrypt.hash(candidate.password, SALT_ROUNDS);

    const result = await Admin.updateOne(
      { email: candidate.email },
      {
        $set: {
          name: candidate.name,
          password: hashedPassword,
        },
        $setOnInsert: {
          email: candidate.email,
        },
      },
      { upsert: true }
    );

    if (result.upsertedCount > 0) {
      console.log(`[seed] Created admin → ${candidate.name} (${candidate.email})`);
      created += 1;
    } else if (result.modifiedCount > 0) {
      console.log(`[seed] Updated admin → ${candidate.name} (${candidate.email})`);
      updated += 1;
    } else {
      console.log(`[seed] Unchanged admin → ${candidate.name} (${candidate.email})`);
    }
  }

  console.log(`[seed] Finished. Created: ${created}, updated: ${updated}.`);
  process.exit(0);
}

seed().catch((error) => {
  console.error("[seed] Failed:", error);
  process.exit(1);
});