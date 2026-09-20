import { connectDB } from "../config/db";
import { BottleInventory } from "../models/BottleInventory";
import { CapInventory } from "../models/CapInventory";
import { LabelInventory } from "../models/LabelInventory";
import {
  PetPackagingInventory,
  computeWeightedUnitCost,
} from "../models/PetPackagingInventory";

/**
 * One-time backfill of the intake-frozen per-piece cost (`unitCostPrice`).
 *
 * The stored per-piece value is authoritative for order costing so it must not
 * inflate as stock is drawn down. Older records either lack the field entirely
 * (caps / PET top-level) or captured a `0` when the data was incomplete. This
 * script fills those gaps from `totalCostPrice ÷ quantity` and leaves any
 * already-valid stored value untouched.
 */
function derive(totalCostPrice: number, quantity: number): number {
  if (!Number.isFinite(totalCostPrice) || quantity <= 0) return 0;
  return Math.round((totalCostPrice / quantity) * 100) / 100;
}

async function backfillCaps(): Promise<number> {
  const caps = await CapInventory.find().lean();
  let updated = 0;
  for (const cap of caps) {
    const current = Number(cap.unitCostPrice) || 0;
    if (current > 0) continue;
    const next = derive(Number(cap.totalCostPrice) || 0, Number(cap.totalQuantity) || 0);
    if (next <= 0) continue;
    await CapInventory.updateOne({ _id: cap._id }, { $set: { unitCostPrice: next } });
    updated += 1;
  }
  return updated;
}

async function backfillPets(): Promise<number> {
  const pets = await PetPackagingInventory.find().lean();
  let updated = 0;
  for (const pet of pets) {
    const current = Number(pet.unitCostPrice) || 0;
    let next = 0;
    if (Array.isArray(pet.sizeDetails) && pet.sizeDetails.length > 0) {
      next = computeWeightedUnitCost(pet.sizeDetails);
    } else {
      next = derive(Number(pet.totalCostPrice) || 0, Number(pet.quantity) || 0);
    }
    if (next <= 0 || next === current) continue;
    await PetPackagingInventory.updateOne(
      { _id: pet._id },
      { $set: { unitCostPrice: next } }
    );
    updated += 1;
  }
  return updated;
}

async function backfillBottles(): Promise<number> {
  const bottles = await BottleInventory.find().lean();
  let updated = 0;
  for (const bottle of bottles) {
    const details = bottle.sizeDetails ?? [];
    let changed = false;
    const nextDetails = details.map((detail) => {
      const current = Number(detail.unitCostPrice) || 0;
      if (current > 0) return detail;
      const next = derive(
        Number(detail.totalCostPrice) || 0,
        Number(detail.quantity) || 0
      );
      if (next <= 0) return detail;
      changed = true;
      return { ...detail, unitCostPrice: next };
    });
    if (!changed) continue;
    await BottleInventory.updateOne(
      { _id: bottle._id },
      { $set: { sizeDetails: nextDetails } }
    );
    updated += 1;
  }
  return updated;
}

async function backfillLabels(): Promise<number> {
  const labels = await LabelInventory.find().lean();
  let updated = 0;
  for (const label of labels) {
    const details = label.sizeDetails ?? [];
    let changed = false;
    const nextDetails = details.map((detail) => {
      const current = Number(detail.unitCostPrice) || 0;
      if (current > 0) return detail;
      const next = derive(
        Number(detail.totalCostPrice) || 0,
        Number(detail.quantity) || 0
      );
      if (next <= 0) return detail;
      changed = true;
      return { ...detail, unitCostPrice: next };
    });
    if (!changed) continue;
    await LabelInventory.updateOne(
      { _id: label._id },
      { $set: { sizeDetails: nextDetails } }
    );
    updated += 1;
  }
  return updated;
}

async function run(): Promise<void> {
  await connectDB();

  const caps = await backfillCaps();
  const pets = await backfillPets();
  const bottles = await backfillBottles();
  const labels = await backfillLabels();

  console.log(
    `[backfill] Updated unitCostPrice → caps: ${caps}, pet-packaging: ${pets}, bottles: ${bottles}, labels: ${labels}.`
  );
  process.exit(0);
}

run().catch((error) => {
  console.error("[backfill] Failed:", error);
  process.exit(1);
});
