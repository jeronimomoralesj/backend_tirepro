// market-data.types.ts
// Place this file alongside your market-data.service.ts

import { Prisma } from '@prisma/client';

export interface PriceEntry {
  price: number;
  date: string;
  source?: string;
}

export interface TireReference {
  brand: string;
  diseno: string;
  dimension: string;
  profundidadInicial?: number;
  estimatedPrice?: number;
}

export interface ScrapedTireData {
  price?: number;
  profundidadInicial?: number;
  source?: string;
}

export interface MarketInsights {
  totalTires: number;
  uniqueReferences: number;
  averageCpk: number;
  averageCpt: number;
  topBrands: Array<{ brand: string; count: number }>;
  tiresWithPriceData: number;
}

export interface ScrapeResult {
  success: boolean;
  tiresCreated: number;
  errors: string[];
}

export interface UpdateResult {
  updated: number;
  errors: string[];
}

// Helper function to safely parse JSON arrays from Prisma
export function parseJsonArray<T>(json: Prisma.JsonValue | null | undefined): T[] {
  if (!json) return [];
  if (Array.isArray(json)) return json as T[];
  return [];
}

// Helper function to convert array to Prisma JSON
export function toJsonValue<T>(arr: T[]): Prisma.InputJsonValue {
  return arr as any;
}