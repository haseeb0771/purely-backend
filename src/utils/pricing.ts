import type { CapInventoryDoc } from "../models/CapInventory";
import type { LabelInventoryDoc } from "../models/LabelInventory";
import type { PetPackagingDoc } from "../models/PetPackagingInventory";

export const WATER_COST_PER_LITER = 2.5;

/** Bottles contained in one PET pack, keyed by bottle size. */
export const BOTTLES_PER_PET: Record<string, number> = {
  "300ml": 12,
  "500ml": 12,
  "1500ml": 6,
  "19L": 1,
};

export const LITERS_PER_SIZE: Record<string, number> = {
  "300ml": 0.3,
  "500ml": 0.5,
  "1500ml": 1.5,
  "19L": 19,
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Cost of a single piece for an intake batch (total cost ÷ quantity).
 * Returns `fallback` when the quantity is unknown/zero (e.g. fully depleted
 * stock) so an out-of-stock item keeps the per-piece cost captured at intake.
 */
export function perPieceCost(
  totalCostPrice: number,
  quantity: number,
  fallback = 0,
): number {
  const total = Number(totalCostPrice);
  const qty = Number(quantity);
  if (!Number.isFinite(total) || !Number.isFinite(qty) || qty <= 0) {
    const safeFallback = Number(fallback);
    return Number.isFinite(safeFallback) && safeFallback > 0
      ? round2(safeFallback)
      : 0;
  }
  return round2(total / qty);
}

/**
 * Per-piece cost for an inventory size/item. The stored per-piece value is
 * authoritative (it is frozen at intake and must not inflate as stock is
 * consumed); we only derive it from total/quantity when it is missing.
 */
export function resolvePerPiece(
  storedUnitCost: number | null | undefined,
  totalCostPrice: number | null | undefined,
  quantity: number | null | undefined,
): number {
  const stored = Number(storedUnitCost);
  if (Number.isFinite(stored) && stored > 0) return round2(stored);
  return perPieceCost(
    Number(totalCostPrice) || 0,
    Number(quantity) || 0,
    0,
  );
}

/**
 * Weighted-average per-piece cost after adding a batch. Uses the current
 * on-hand quantity and its stored per-piece cost (not the cumulative intake
 * total) so the average stays stable once orders have drawn stock down.
 */
export function weightedPerPiece(
  prevQuantity: number,
  prevUnitCost: number,
  addQuantity: number,
  addTotalCostPrice: number,
): number {
  const prevQty = Math.max(0, Number(prevQuantity) || 0);
  const addQty = Math.max(0, Number(addQuantity) || 0);
  const totalQty = prevQty + addQty;
  if (totalQty <= 0) return 0;
  const prevUnit = Math.max(0, Number(prevUnitCost) || 0);
  const addUnit = perPieceCost(addTotalCostPrice, addQty, 0);
  return round2((prevQty * prevUnit + addQty * addUnit) / totalQty);
}

export function computeTotalLiters(
  entries: { size: string; quantity: number }[],
): number {
  return round2(
    entries.reduce(
      (sum, entry) => sum + (entry.quantity || 0) * (LITERS_PER_SIZE[entry.size] ?? 0),
      0,
    ),
  );
}

export function computeWaterCost(liters: number, rate = WATER_COST_PER_LITER): number {
  return round2(liters * rate);
}

export interface BottlePriceLine {
  size: string;
  quantity: number;
  petCount: number;
  bottlesPerPET: number;
  bottleCostPerUnit: number;
  capCostPerUnit: number;
  labelCostPerUnit: number;
  petPackCostPerUnit: number;
  waterCostPerBottle: number;
  costPerUnit: number;
  costPerBottle: number;
  costPerPET: number;
  sellPerUnit: number;
  sellPerPET: number;
  bottleCostAmount: number;
  capCostAmount: number;
  labelCostAmount: number;
  petPackCostAmount: number;
  waterCostAmount: number;
  costAmount: number;
  sellAmount: number;
}

export interface PetPriceLine {
  petPackagingId: string;
  size: string;
  quantity: number;
  costPerUnit: number;
  sellPerUnit: number;
  costAmount: number;
  sellAmount: number;
}

export interface PriceBreakdownData {
  bottleLines: BottlePriceLine[];
  petLines: PetPriceLine[];
  water: { liters: number; rate: number; amount: number };
  componentTotals: {
    bottles: number;
    caps: number;
    labels: number;
    pet: number;
    water: number;
  };
  totals: { cost: number; sell: number; profit: number };
}

export interface PricingSizeInput {
  size: string;
  petCount: number;
  bottleCount: number;
  bottleCostPerUnit: number;
}

export interface PricingInput {
  sizes: PricingSizeInput[];
  labelQuantities: { size: string; quantity: number }[];
  /** Selling price per bottle (legacy per-bottle pricing). */
  bottleSellPerUnit?: Record<string, number>;
  /** Selling price per PET pack, keyed by size (per-PET flow). */
  sellPerPET?: Record<string, number>;
  petSellPerUnit?: Record<string, number>;
  waterRate?: number;
}

export interface PricingDeps {
  cap: Pick<
    CapInventoryDoc,
    "totalCostPrice" | "totalQuantity" | "unitCostPrice"
  >;
  label: Pick<LabelInventoryDoc, "sizeDetails"> | null;
  /** Primary per-size pack used for the per-size bottle line display. */
  petBySize: Record<
    string,
    {
      pet: Pick<
        PetPackagingDoc,
        "_id" | "size" | "totalCostPrice" | "quantity" | "unitCostPrice" | "sizeDetails"
      >;
      quantity: number;
    }
  >;
  /** Every PET-packaging selection consumed by the order (costed exactly once). */
  pets: {
    pet: Pick<
      PetPackagingDoc,
      "_id" | "size" | "totalCostPrice" | "quantity" | "unitCostPrice" | "sizeDetails"
    >;
    size: string;
    quantity: number;
  }[];
}

/**
 * Per-piece cost of a PET packaging record for a given size. Prefers the
 * stored per-size intake cost, then the stored top-level cost, then derives
 * from total ÷ quantity. Survives zero stock.
 */
function petPerPiece(
  pet: Pick<
    PetPackagingDoc,
    | "size"
    | "totalCostPrice"
    | "quantity"
    | "unitCostPrice"
    | "sizeDetails"
  >,
  size: string = pet.size,
): number {
  const detail = pet.sizeDetails?.find((entry) => entry.size === size);
  if (detail) {
    return resolvePerPiece(
      detail.unitCostPrice,
      detail.totalCostPrice,
      detail.quantity,
    );
  }
  return resolvePerPiece(pet.unitCostPrice, pet.totalCostPrice, pet.quantity);
}

export function buildPricing(
  input: PricingInput,
  deps: PricingDeps,
): { breakdown: PriceBreakdownData; totalCost: number; totalSell: number } {
  const bottleLines: BottlePriceLine[] = [];
  const petLines: PetPriceLine[] = [];
  const waterRate = Number.isFinite(input.waterRate)
    ? Math.max(0, Number(input.waterRate))
    : WATER_COST_PER_LITER;

  const capUnitCost = resolvePerPiece(
    deps.cap.unitCostPrice,
    deps.cap.totalCostPrice,
    deps.cap.totalQuantity,
  );

  for (const item of input.sizes) {
    const labelDetail = deps.label?.sizeDetails.find(
      (entry) => entry.size === item.size,
    );
    const labelCostPerUnit = resolvePerPiece(
      labelDetail?.unitCostPrice,
      labelDetail?.totalCostPrice,
      labelDetail?.quantity,
    );
    const labelQty =
      input.labelQuantities.find((l) => l.size === item.size)?.quantity ??
      item.bottleCount;

    const packEntry = deps.petBySize[item.size];
    const petUnitCost = packEntry ? petPerPiece(packEntry.pet, item.size) : 0;

    const bottlesPerPET = BOTTLES_PER_PET[item.size] ?? 1;
    const waterCostPerBottle = round2(
      (LITERS_PER_SIZE[item.size] ?? 0) * waterRate,
    );

    const bottleCostAmount = round2(item.bottleCostPerUnit * item.bottleCount);
    const capCostAmount = round2(capUnitCost * item.bottleCount);
    const labelCostAmount = round2(labelCostPerUnit * labelQty);
    const petPackCostAmount = round2(petUnitCost * item.petCount);
    const waterCostAmount = round2(waterCostPerBottle * item.bottleCount);

    const costPerUnit = round2(
      item.bottleCostPerUnit + capUnitCost + labelCostPerUnit,
    );
    const costPerBottle = round2(costPerUnit + waterCostPerBottle);
    const costPerPET = round2(
      item.petCount > 0
        ? costPerBottle * bottlesPerPET + petUnitCost
        : costPerBottle * bottlesPerPET,
    );
    const costAmount = round2(
      bottleCostAmount + capCostAmount + labelCostAmount + petPackCostAmount + waterCostAmount,
    );

    const sellPerPET = Number.isFinite(input.sellPerPET?.[item.size])
      ? Math.max(0, Number(input.sellPerPET?.[item.size]))
      : costPerPET;
    const sellPerUnit = Number.isFinite(input.bottleSellPerUnit?.[item.size])
      ? Math.max(0, Number(input.bottleSellPerUnit?.[item.size]))
      : item.petCount > 0
        ? round2(sellPerPET / bottlesPerPET)
        : costPerUnit;
    const sellAmount =
      item.petCount > 0 && Number.isFinite(input.sellPerPET?.[item.size])
        ? round2(sellPerPET * item.petCount)
        : round2(sellPerUnit * item.bottleCount);

    bottleLines.push({
      size: item.size,
      quantity: item.bottleCount,
      petCount: item.petCount,
      bottlesPerPET,
      bottleCostPerUnit: round2(item.bottleCostPerUnit),
      capCostPerUnit: round2(capUnitCost),
      labelCostPerUnit: round2(labelCostPerUnit),
      petPackCostPerUnit: round2(petUnitCost),
      waterCostPerBottle,
      costPerUnit,
      costPerBottle,
      costPerPET,
      sellPerUnit,
      sellPerPET,
      bottleCostAmount,
      capCostAmount,
      labelCostAmount,
      petPackCostAmount,
      waterCostAmount,
      costAmount,
      sellAmount,
    });

    if (packEntry) {
      const sellPerUnitPet = round2(
        input.petSellPerUnit?.[String(packEntry.pet._id)] ?? petUnitCost,
      );
      petLines.push({
        petPackagingId: String(packEntry.pet._id),
        size: item.size,
        quantity: item.petCount,
        costPerUnit: round2(petUnitCost),
        sellPerUnit: sellPerUnitPet,
        costAmount: petPackCostAmount,
        sellAmount: round2(sellPerUnitPet * item.petCount),
      });
    }
  }

  const liters = round2(
    input.sizes.reduce(
      (sum, item) => sum + (item.bottleCount || 0) * (LITERS_PER_SIZE[item.size] ?? 0),
      0,
    ),
  );
  const waterAmount = computeWaterCost(liters, waterRate);

  // Cost every PET-packaging selection exactly once (bottle-size packs are
  // already accounted for above, so only sizes without a bottle line or extra
  // same-size selections are appended). Keeps legacy orders backward compatible.
  const coveredSizes = new Set(input.sizes.map((item) => item.size));
  const seenPets = new Set(petLines.map((l) => `${l.petPackagingId}::${l.size}`));
  for (const { pet, size, quantity } of deps.pets) {
    if (seenPets.has(`${String(pet._id)}::${size}`)) continue;
    const unitCost = petPerPiece(pet, size);
    const costAmount = round2(unitCost * quantity);
    const sellPerUnitPet = round2(
      input.petSellPerUnit?.[String(pet._id)] ?? unitCost,
    );
    petLines.push({
      petPackagingId: String(pet._id),
      size,
      quantity,
      costPerUnit: round2(unitCost),
      sellPerUnit: sellPerUnitPet,
      costAmount,
      sellAmount: round2(sellPerUnitPet * quantity),
    });
    void coveredSizes;
  }

  const bottles = round2(
    bottleLines.reduce((sum, l) => sum + l.bottleCostAmount, 0),
  );
  const caps = round2(bottleLines.reduce((sum, l) => sum + l.capCostAmount, 0));
  const labels = round2(
    bottleLines.reduce((sum, l) => sum + l.labelCostAmount, 0),
  );
  // PET packaging is costed exactly once across all selections (petLines).
  const pet = round2(petLines.reduce((sum, l) => sum + l.costAmount, 0));
  const totalCost = round2(bottles + caps + labels + pet + waterAmount);
  const totalSell = round2(
    bottleLines.reduce((sum, l) => sum + l.sellAmount, 0) +
      petLines.reduce((sum, l) => sum + l.sellAmount, 0),
  );

  return {
    breakdown: {
      bottleLines,
      petLines,
      water: { liters, rate: waterRate, amount: waterAmount },
      componentTotals: { bottles, caps, labels, pet, water: waterAmount },
      totals: {
        cost: totalCost,
        sell: totalSell,
        profit: round2(totalSell - totalCost),
      },
    },
    totalCost,
    totalSell,
  };
}