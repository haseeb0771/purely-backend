import { BottleInventory } from "../models/BottleInventory";
import { CapInventory } from "../models/CapInventory";
import { LabelInventory } from "../models/LabelInventory";
import { PetPackagingInventory } from "../models/PetPackagingInventory";
import { Notification } from "../models/Notification";
import { persistNotification } from "./notifications";
import { emitToAdmins } from "../sockets";

export type StockAlertModule =
  | "bottles"
  | "caps"
  | "labels"
  | "pet-packaging";

export interface StockAlertItem {
  itemId: string;
  module: StockAlertModule;
  customId: string;
  name: string;
  imageUrl?: string;
  size?: string;
  quantity: number;
  stockAlertLevel: number;
  href: string;
}

export async function collectStockAlerts(): Promise<StockAlertItem[]> {
  const [bottles, caps, labels, pets] = await Promise.all([
    BottleInventory.find().lean(),
    CapInventory.find().lean(),
    LabelInventory.find().lean(),
    PetPackagingInventory.find().lean(),
  ]);

  const alerts: StockAlertItem[] = [];

  for (const bottle of bottles) {
    for (const sd of bottle.sizeDetails ?? []) {
      const configuredLevel = sd.stockAlertLevel ?? 0;
      const stock = sd.quantity || 0;
      const effectiveLevel = configuredLevel > 0 ? configuredLevel : stock <= 0 ? 1 : 0;
      if (effectiveLevel > 0 && stock < effectiveLevel) {
        alerts.push({
          itemId: String(bottle._id),
          module: "bottles",
          customId: bottle.customId,
          name: bottle.bottleName,
          imageUrl: bottle.imageUrl,
          size: sd.size,
          quantity: stock,
          stockAlertLevel: effectiveLevel,
          href: `/admin/inventory/bottles?open=${String(bottle._id)}`,
        });
      }
    }
  }

  for (const cap of caps) {
    const configuredLevel = cap.stockAlertLevel ?? 0;
    const stock = cap.totalQuantity ?? 0;
    const effectiveLevel = configuredLevel > 0 ? configuredLevel : stock <= 0 ? 1 : 0;
    if (effectiveLevel > 0 && stock < effectiveLevel) {
      alerts.push({
        itemId: String(cap._id),
        module: "caps",
        customId: cap.customId,
        name: cap.color,
        imageUrl: cap.imageUrl,
        quantity: stock,
        stockAlertLevel: effectiveLevel,
        href: `/admin/inventory/caps?open=${String(cap._id)}`,
      });
    }
  }

  for (const label of labels) {
    for (const sd of label.sizeDetails ?? []) {
      const configuredLevel = sd.stockAlertLevel ?? 0;
      const stock = sd.quantity || 0;
      const effectiveLevel = configuredLevel > 0 ? configuredLevel : stock <= 0 ? 1 : 0;
      if (effectiveLevel > 0 && stock < effectiveLevel) {
        alerts.push({
          itemId: String(label._id),
          module: "labels",
          customId: label.customId,
          name: label.name,
          imageUrl: label.imageUrl,
          size: sd.size,
          quantity: stock,
          stockAlertLevel: effectiveLevel,
          href: `/admin/inventory/labels?open=${String(label._id)}`,
        });
      }
    }
  }

  for (const pet of pets) {
    // Multi-size records (added from the web app) alert per size; legacy
    // flat records fall back to their top-level size/quantity.
    const details = pet.sizeDetails ?? [];
    if (details.length > 0) {
      for (const sd of details) {
        const configuredLevel = sd.stockAlertLevel ?? 0;
        const stock = sd.quantity || 0;
        const effectiveLevel =
          configuredLevel > 0 ? configuredLevel : stock <= 0 ? 1 : 0;
        if (effectiveLevel > 0 && stock < effectiveLevel) {
          alerts.push({
            itemId: String(pet._id),
            module: "pet-packaging",
            customId: pet.customId,
            name: pet.size,
            size: sd.size,
            quantity: stock,
            stockAlertLevel: effectiveLevel,
            href: `/admin/inventory/pet-packaging?open=${String(pet._id)}`,
          });
        }
      }
    } else {
      const configuredLevel = pet.stockAlertLevel ?? 0;
      const stock = pet.quantity ?? 0;
      const effectiveLevel =
        configuredLevel > 0 ? configuredLevel : stock <= 0 ? 1 : 0;
      if (effectiveLevel > 0 && stock < effectiveLevel) {
        alerts.push({
          itemId: String(pet._id),
          module: "pet-packaging",
          customId: pet.customId,
          name: pet.size,
          quantity: stock,
          stockAlertLevel: effectiveLevel,
          href: `/admin/inventory/pet-packaging?open=${String(pet._id)}`,
        });
      }
    }
  }

  alerts.sort(
    (a, b) =>
      b.stockAlertLevel - b.quantity - (a.stockAlertLevel - a.quantity)
  );

  return alerts;
}

export async function checkAndNotifyStockAlerts(): Promise<void> {
  try {
    const alerts = await collectStockAlerts();

    for (const alert of alerts) {
      const existing = await Notification.findOne({
        type: "inventory",
        action: "STOCK_ALERT",
        module: alert.module,
        itemId: alert.itemId,
        readBy: { $size: 0 },
      }).lean();

      if (existing) continue;

      const title = "Low Stock Alert";
      const sizeLabel = alert.size ? ` (${alert.size})` : "";
      const message = `${alert.customId} (${alert.name})${sizeLabel} stock is ${alert.quantity}, below the alert level of ${alert.stockAlertLevel}.`;

      await persistNotification({
        type: "inventory",
        action: "STOCK_ALERT",
        title,
        message,
        module: alert.module,
        itemId: alert.itemId,
        href: alert.href,
      });

      emitToAdmins("stock_alert", {
        type: "STOCK_ALERT",
        module: alert.module,
        itemId: alert.itemId,
        title,
        message,
        timestamp: new Date().toISOString(),
        data: alert,
      });
    }
  } catch (error) {
    console.error("[stock-alerts] check failed:", error);
  }
}