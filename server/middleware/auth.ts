import { Request, Response, NextFunction } from 'express';
import { jwtVerify, createRemoteJWKSet, JWTPayload } from 'jose';
import { findNeonUser } from '../services/neonUser.js';
import { prisma } from '../config/prisma.js';


export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'merchant' | 'customer' | null;
  name: string | null;
  store_id?: number | null;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

const NEON_AUTH_JWKS_URL = process.env.NEON_AUTH_JWKS_URL;
const NEON_AUTH_BASE_URL = process.env.NEON_AUTH_BASE_URL;

let neonJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let neonIssuer = "";

try {
    if (NEON_AUTH_JWKS_URL) {
        neonJWKS = createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL))
    }
    if (NEON_AUTH_BASE_URL) {
        neonIssuer = new URL(NEON_AUTH_BASE_URL).origin;
    }
} catch (error) {
    console.error('Invalid NEON_AUTH_BASE_URL:', error);
}

// Verifies authentication token using Neon Auth JWKS (jose JwtVerify)
// Returns null for invalid, expired, deleted or banned users.
// Database errors are thrown so they surface as 500s instead of fake 401s.
export const verifyAuthToken = async (token: string | undefined):
Promise<AuthUser | null> => {
    if (!token || !neonIssuer || !neonJWKS) return null;

    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(token, neonJWKS, { issuer: neonIssuer }));
    } catch {
        return null;
    }
    if (!payload.sub && !payload.email) return null;

    const userEmail = String(payload.email || "").toLowerCase();
    const userId = String(payload.sub || payload.id || "");

    const u = await findNeonUser({
        ...(userId ? { id: userId } : {}),
        ...(userEmail ? { email: userEmail } : {}),
    });

    // User was deleted after the token was issued
    if (!u) return null;

    // User is banned (permanently, or until banExpires)
    if (u.banned && (!u.banExpires || u.banExpires > new Date())) return null;

    const store = await prisma.stores.findFirst({ where: { merchant_id: u.id } });

    // Role comes only from the database, never from the email or token claims
    let role: 'admin' | 'merchant' | 'customer' = 'customer';
    if (u.role === 'admin') {
        role = 'admin';
    } else if (store || u.role === 'merchant') {
        role = 'merchant';
    }

    return {
        id: u.id,
        email: u.email,
        name: u.name || u.email.split("@")[0],
        role,
        store_id: role === 'admin' ? null : store?.id ?? null,
    };
}

export const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) : Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid Authorization header' });
        return;
    }

    const token = authHeader.split(' ')[1];
    const user = await verifyAuthToken(token);
    if (!user) {
        res.status(401).json({ success: false, message: 'Unauthorized: Invalid or expired token' });
        return;
    }

    req.user = user;
    next();
}

export const optionalAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) : Promise<void> => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const user = await verifyAuthToken(token);
        if (user) {
            req.user = user;
        }
    }
    next();
}

export const requireRole = (roles: Array<'admin' | 'merchant' | 'customer'>) => {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        if (!req.user || !req.user.role || !roles.includes(req.user.role)) {
            res.status(403).json({ success: false, message: 'Forbidden: Access denied' });
            return;
        }
        next();
    };
};