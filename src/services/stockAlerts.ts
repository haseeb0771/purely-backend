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
      const alertLevel = sd.stockAlertLevel ?? 0;
      if (alertLevel > 0 && (sd.quantity || 0) < alertLevel) {
        alerts.push({
          itemId: String(bottle._id),
          module: "bottles",
          customId: bottle.customId,
          name: bottle.bottleName,
          imageUrl: bottle.imageUrl,
          size: sd.size,
          quantity: sd.quantity || 0,
          stockAlertLevel: alertLevel,
          href: `/admin/inventory/bottles?open=${String(bottle._id)}`,
        });
      }
    }
  }

  for (const cap of caps) {
    if (cap.stockAlertLevel > 0 && cap.totalQuantity < cap.stockAlertLevel) {
      alerts.push({
        itemId: String(cap._id),
        module: "caps",
        customId: cap.customId,
        name: cap.color,
        imageUrl: cap.imageUrl,
        quantity: cap.totalQuantity,
        stockAlertLevel: cap.stockAlertLevel,
        href: `/admin/inventory/caps?open=${String(cap._id)}`,
      });
    }
  }

  for (const label of labels) {
    for (const sd of label.sizeDetails ?? []) {
      const alertLevel = sd.stockAlertLevel ?? 0;
      if (alertLevel > 0 && (sd.quantity || 0) < alertLevel) {
        alerts.push({
          itemId: String(label._id),
          module: "labels",
          customId: label.customId,
          name: label.name,
          imageUrl: label.imageUrl,
          size: sd.size,
          quantity: sd.quantity || 0,
          stockAlertLevel: alertLevel,
          href: `/admin/inventory/labels?open=${String(label._id)}`,
        });
      }
    }
  }

  for (const pet of pets) {
    if (pet.stockAlertLevel > 0 && pet.quantity < pet.stockAlertLevel) {
      alerts.push({
        itemId: String(pet._id),
        module: "pet-packaging",
        customId: pet.customId,
        name: pet.size,
        quantity: pet.quantity,
        stockAlertLevel: pet.stockAlertLevel,
        href: `/admin/inventory/pet-packaging?open=${String(pet._id)}`,
      });
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