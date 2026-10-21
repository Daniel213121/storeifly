import { runInThisContext } from "node:vm";
import { prisma } from "../config/prisma.js";

export interface NeonUserRecord {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  createdAt: Date;
  updatedAt: Date;
  banned: boolean | null;
  banExpires: Date | null;
}

export const findNeonUser = async (filter: { id?: string; email?: string }) :
 Promise<NeonUserRecord | null> => {
    if (filter.id) {
        const rows = await prisma.$queryRaw<NeonUserRecord[]>
        `SELECT id, name, email, role, "createdAt", "updatedAt", banned, "banExpires"
        FROM neon_auth."user"
        WHERE id = ${filter.id}::uuid
        LIMIT 1`;
        return rows[0] ?? null;
    }
    if (filter.email) {
        const rows = await prisma.$queryRaw<NeonUserRecord[]>
        `SELECT id, name, email, role, "createdAt", "updatedAt", banned, "banExpires"
        FROM neon_auth."user"
        WHERE LOWER(email) = ${filter.email.trim().toLowerCase()}
        LIMIT 1`;
        return rows[0] ?? null;
    }
    return null;
};

export const updateNeonUserRole = async (userId: string, role: string): Promise<void> => {
    try {
        await prisma.$executeRaw`
        UPDATE neon_auth."user" 
        SET role = ${role}, "updatedAt" = NOW()
        WHERE id = ${userId}::uuid AND (role IS NULL OR role != 'admin' AND role != 'merchant')`;
    } catch (error) {
        console.error(error);
        throw new Error("Failed to update Neon user role: " + (error as Error).message);
    }
};

// Looks up many Neon Auth users at once. Returns { [id]: user }.
// Database errors are thrown so callers can return a 500.
export const findNeonUserByIds = async (ids: string[]) : Promise<Record<string, NeonUserRecord>> => {
    const uniqueIds = Array.from(new Set((ids ?? []).filter(Boolean)));
    if (uniqueIds.length === 0) return {};

    const rows = await prisma.$queryRaw<NeonUserRecord[]>`
        SELECT id, name, email, role, "createdAt", "updatedAt", banned, "banExpires"
        FROM neon_auth."user"
        WHERE id = ANY(${uniqueIds}::uuid[])`;

    const map: Record<string, NeonUserRecord> = {};
    for (const row of rows) {
        map[row.id] = row;
    }
    return map;
}

// All Neon Auth users with the merchant role, newest first.
// Database errors are thrown so callers can return a 500.
export const findNeonMerchants = async () : Promise<NeonUserRecord[]> => {
    return prisma.$queryRaw<NeonUserRecord[]>`
        SELECT id, name, email, role, "createdAt", "updatedAt", banned, "banExpires"
        FROM neon_auth."user"
        WHERE role = 'merchant'
        ORDER BY "createdAt" DESC`;
}

// True only if the user has confirmed they own their email address
export const isNeonEmailVerified = async (userId: string) : Promise<boolean> => {
    const rows = await prisma.$queryRaw<{ emailVerified: boolean | null }[]>`
        SELECT "emailVerified" FROM neon_auth."user" WHERE id = ${userId}::uuid LIMIT 1`;
    return rows[0]?.emailVerified === true;
}
