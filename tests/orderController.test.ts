/**
 * Integration tests for the order creation flow (createOrder + helpers).
 * Uses an in-memory MongoDB replica set so transactions are supported.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { existsSync } from "fs";

process.env.JWT_SECRET ??= "test-secret-for-vitest-only";

let mongod: MongoMemoryServer;
let usedLocalMongod = false;

beforeAll(async () => {
  // Prefer the locally installed mongod; fall back to the binary
  // mongodb-memory-server downloads on first use.
  try {
    const localBin = "C:\\Program Files\\MongoDB\\Server\\8.3\\bin\\mongod.exe";
    if (existsSync(localBin)) {
      usedLocalMongod = true;
      mongod = await MongoMemoryServer.create({
        binary: { systemBinary: localBin },
        instance: { args: ["--replSet", "rs0"] },
      });
    }
  } catch {
    // no local mongod — fall through to downloaded binary
  }
  if (!usedLocalMongod) {
    mongod = await MongoMemoryServer.create({
      instance: { args: ["--replSet", "rs0"] },
    });
  }

  // Initiate the single-node replica set manually (this MMS version does
  // not auto-initiate when --replSet is passed via raw args).
  const { MongoClient } = await import("mongodb");
  const uri = mongod.getUri();
  const port = new URL(uri).port;
  const direct = new MongoClient(uri, { directConnection: true });
  await direct.connect();
  await direct.db("admin").command({
    replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `127.0.0.1:${port}` }] },
  });
  await direct.close();

  let primary = false;
  for (let i = 0; i < 30 && !primary; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const probe = new MongoClient(uri, { directConnection: true });
    await probe.connect();
    const hello = await probe.db("admin").command({ hello: 1 });
    await probe.close();
    primary = hello.isWritablePrimary;
  }
  if (!primary) throw new Error("Replica set failed to elect a primary in 30s");

  await mongoose.connect(uri);
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

import { BottleInventory } from "../src/models/BottleInventory";
import { CapInventory } from "../src/models/CapInventory";
import { LabelInventory } from "../src/models/LabelInventory";
import { PetPackagingInventory } from "../src/models/PetPackagingInventory";
import { Admin } from "../src/models/Admin";
import { Order } from "../src/models/Order";
import {
  checkOrderStock,
  createOrder,
  parseOrderPayload,
} from "../src/controllers/orderController";
import type { AuthRequest } from "../src/middleware/auth";

type ResLike = {
  statusCode?: number;
  body?: unknown;
  status(code: number): ResLike;
  json(payload: unknown): ResLike;
};

function makeRes(): ResLike {
  const res: ResLike = {
    statusCode: undefined,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

async function seedInventory() {
  const admin = await Admin.create({
    name: "Test Admin",
    email: "admin@test.local",
    password: "super-secret-password",
    role: "ADMIN",
  });

  const bottle = await BottleInventory.create({
    customId: "BOT-001",
    bottleName: "Test Bottle",
    type: "Pure",
    imageUrl: "https://example.com/bottle.png",
    createdBy: admin._id,
    sizeDetails: [
      { size: "500ml", quantity: 100, totalCostPrice: 5000, unitCostPrice: 50 },
      { size: "19L", quantity: 40, totalCostPrice: 4000, unitCostPrice: 100 },
    ],
  });

  const cap = await CapInventory.create({
    customId: "CAP-001",
    color: "Blue",
    imageUrl: "https://example.com/cap.png",
    totalQuantity: 500,
    totalCostPrice: 1000,
    createdBy: admin._id,
  });

  const label = await LabelInventory.create({
    customId: "LBL-001",
    name: "Test Label",
    imageUrl: "https://example.com/label.png",
    createdBy: admin._id,
    sizeDetails: [
      { size: "500ml", quantity: 80, totalCostPrice: 1600, unitCostPrice: 20 },
      { size: "19L", quantity: 50, totalCostPrice: 1500, unitCostPrice: 30 },
    ],
  });

  const pet = await PetPackagingInventory.create({
    customId: "PET-001",
    size: "500ml",
    quantity: 200,
    totalCostPrice: 2000,
    createdBy: admin._id,
  });

  return { admin, bottle, cap, label, pet };
}

function makeReq(
  adminId: mongoose.Types.ObjectId,
  body: Record<string, unknown>,
): AuthRequest {
  return {
    body,
    admin: { _id: adminId, name: "Test Admin" },
    headers: {},
    cookies: {},
  } as unknown as AuthRequest;
}

function validBody(seed: Awaited<ReturnType<typeof seedInventory>>) {
  return {
    clientDetails: {
      businessName: "Acme Water",
      ownerName: "Jane Doe",
      ownerPhone: "0800000000",
      isWhatsappSameAsPhone: true,
    },
    bottleSelection: {
      bottleId: String(seed.bottle._id),
      sizes: ["500ml", "19L"],
      sizeQuantities: [
        { size: "500ml", quantity: 10 },
        { size: "19L", quantity: 5 },
      ],
    },
    capSelection: { capId: String(seed.cap._id) },
    labelSelection: {
      type: "EXISTING_INVENTORY",
      labelId: String(seed.label._id),
    },
    petPackagingSelection: [
      { petPackagingId: String(seed.pet._id), size: "500ml", quantity: 5 },
    ],
  };
}

describe("parseOrderPayload", () => {
  const baseClient = {
    businessName: "B",
    ownerName: "x",
    ownerPhone: "1",
    isWhatsappSameAsPhone: true,
  };
  const baseBottle = () => ({
    sizes: ["500ml"],
    sizeQuantities: [{ size: "500ml", quantity: 1 }],
    bottleId: new mongoose.Types.ObjectId().toString(),
  });
  const baseRest = () => ({
    capSelection: { capId: new mongoose.Types.ObjectId().toString() },
    labelSelection: { type: "NEW_DESIGN", logoImageUrl: "x" },
  });

  it("rejects missing business name", () => {
    expect(() =>
      parseOrderPayload({
        clientDetails: {
          ownerName: "x",
          ownerPhone: "1",
          isWhatsappSameAsPhone: true,
        },
        bottleSelection: baseBottle(),
        ...baseRest(),
      }),
    ).toThrow("Business name is required.");
  });

  it("rejects zero bottle sizes", () => {
    expect(() =>
      parseOrderPayload({
        clientDetails: baseClient,
        bottleSelection: { ...baseBottle(), sizes: [], sizeQuantities: [] },
        ...baseRest(),
      }),
    ).toThrow("Select at least one bottle size.");
  });

  it("rejects invalid bottle ObjectId", () => {
    expect(() =>
      parseOrderPayload({
        clientDetails: baseClient,
        bottleSelection: { ...baseBottle(), bottleId: "not-an-id" },
        ...baseRest(),
      }),
    ).toThrow("A valid bottle is required.");
  });

  it("rejects NEW_DESIGN without a logo upload", () => {
    expect(() =>
      parseOrderPayload({
        clientDetails: baseClient,
        bottleSelection: baseBottle(),
        capSelection: baseRest().capSelection,
        labelSelection: { type: "NEW_DESIGN" },
      }),
    ).toThrow("Upload a logo image for the new label design.");
  });
});

describe("createOrder", () => {
  it("creates an order and decrements all inventory (happy path)", async () => {
    const seed = await seedInventory();
    const req = makeReq(seed.admin._id, validBody(seed));
    const res = makeRes();

    await createOrder(req, res as never);

    expect(res.statusCode).toBe(201);
    expect((res.body as { success: boolean }).success).toBe(true);

    const order = await Order.findOne({
      "clientDetails.businessName": "Acme Water",
    });
    expect(order).not.toBeNull();
    expect(order!.orderId).toMatch(/^ORD-\d{8}-\d{5}$/);

    const bottle = await BottleInventory.findById(seed.bottle._id);
    expect(bottle!.sizeDetails.find((s) => s.size === "500ml")!.quantity).toBe(
      90,
    );
    expect(bottle!.sizeDetails.find((s) => s.size === "19L")!.quantity).toBe(
      35,
    );

    const cap = await CapInventory.findById(seed.cap._id);
    expect(cap!.totalQuantity).toBe(485); // 500 - 15

    const label = await LabelInventory.findById(seed.label._id);
    expect(label!.sizeDetails.find((s) => s.size === "500ml")!.quantity).toBe(
      70,
    );
    expect(label!.sizeDetails.find((s) => s.size === "19L")!.quantity).toBe(45);

    const pet = await PetPackagingInventory.findById(seed.pet._id);
    expect(pet!.quantity).toBe(195);
  });

  it("rolls back all stock when Order.create fails", async () => {
    const seed = await seedInventory();
    const req = makeReq(seed.admin._id, validBody(seed));
    const res = makeRes();

    const spy = vi
      .spyOn(Order, "create")
      .mockImplementation(
        () => Promise.reject(new Error("forced failure")) as never,
      );

    await createOrder(req, res as never);

    spy.mockRestore();

    expect(res.statusCode).toBe(500);

    // All inventory must be unchanged because the transaction rolled back.
    const bottle = await BottleInventory.findById(seed.bottle._id);
    expect(bottle!.sizeDetails.find((s) => s.size === "500ml")!.quantity).toBe(
      100,
    );
    const cap = await CapInventory.findById(seed.cap._id);
    expect(cap!.totalQuantity).toBe(500);
    const pet = await PetPackagingInventory.findById(seed.pet._id);
    expect(pet!.quantity).toBe(200);
    expect(await Order.countDocuments()).toBe(0);
  });

  it("returns 400 for insufficient bottle stock", async () => {
    const seed = await seedInventory();
    const body = validBody(seed);
    (body.bottleSelection.sizeQuantities[0] as { quantity: number }).quantity =
      1000;
    const res = makeRes();
    await createOrder(makeReq(seed.admin._id, body), res as never);

    expect(res.statusCode).toBe(400);
    expect((res.body as { message: string }).message).toContain(
      "Insufficient 500ml bottle stock",
    );
    expect(await Order.countDocuments()).toBe(0);
  });

  it("returns 400 for insufficient cap stock", async () => {
    const seed = await seedInventory();
    await CapInventory.updateOne({ _id: seed.cap._id }, { totalQuantity: 5 });
    const res = makeRes();
    await createOrder(makeReq(seed.admin._id, validBody(seed)), res as never);

    expect(res.statusCode).toBe(400);
    expect((res.body as { message: string }).message).toContain(
      "Insufficient cap stock",
    );
    expect(await Order.countDocuments()).toBe(0);
  });

  it("returns 400 for insufficient label stock", async () => {
    const seed = await seedInventory();
    await LabelInventory.updateOne(
      { _id: seed.label._id },
      { $set: { "sizeDetails.0.quantity": 1 } },
    );
    const res = makeRes();
    await createOrder(makeReq(seed.admin._id, validBody(seed)), res as never);

    expect(res.statusCode).toBe(400);
    expect((res.body as { message: string }).message).toContain(
      "Insufficient 500ml label stock",
    );
    expect(await Order.countDocuments()).toBe(0);
  });

  it("returns 400 for a size the bottle does not carry", async () => {
    const seed = await seedInventory();
    const body = validBody(seed);
    body.bottleSelection.sizes = ["1500ml"];
    body.bottleSelection.sizeQuantities = [{ size: "1500ml", quantity: 1 }];
    const res = makeRes();
    await createOrder(makeReq(seed.admin._id, body), res as never);

    expect(res.statusCode).toBe(400);
    expect((res.body as { message: string }).message).toContain(
      "does not include size 1500ml",
    );
    expect(await Order.countDocuments()).toBe(0);
  });

  it("returns 400 for a nonexistent bottle", async () => {
    const seed = await seedInventory();
    const body = validBody(seed);
    body.bottleSelection.bottleId = new mongoose.Types.ObjectId().toString();
    const res = makeRes();
    await createOrder(makeReq(seed.admin._id, body), res as never);

    expect(res.statusCode).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      "Selected bottle was not found.",
    );
  });

  it("returns 400 when PET packaging size mismatches", async () => {
    const seed = await seedInventory();
    const other = await PetPackagingInventory.create({
      customId: "PET-002",
      size: "19L",
      quantity: 50,
      totalCostPrice: 900,
      createdBy: seed.admin._id,
    });
    const body = validBody(seed);
    body.petPackagingSelection = [
      { petPackagingId: String(other._id), size: "500ml", quantity: 1 },
    ];
    const res = makeRes();
    await createOrder(makeReq(seed.admin._id, body), res as never);

    expect(res.statusCode).toBe(400);
    expect((res.body as { message: string }).message).toContain(
      "size mismatch",
    );
    expect(await Order.countDocuments()).toBe(0);
  });

  it("checkOrderStock throws for quantities beyond stock", async () => {
    const seed = await seedInventory();
    const payload = parseOrderPayload(validBody(seed));
    payload.sizeQuantities[0].quantity = 99999;
    await expect(checkOrderStock(payload)).rejects.toThrow(
      /Insufficient 500ml bottle stock/,
    );
  });
});
