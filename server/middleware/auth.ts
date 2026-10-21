import { Request, Response, NextFunction } from 'express';
import { jwtVerify, createRemoteJWKSet } from 'jose';
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
export const verifyAuthToken = async (token: string): 
Promise<AuthUser | null> => {
    if (!token || !neonIssuer || !neonJWKS) return null;
    
    try {
        const { payload } = await jwtVerify(token, neonJWKS, {issuer: neonIssuer});
        if (!payload || (!payload.sub && !payload.email)) return null;

        const userEmail = String(payload.email || "").toLowerCase()
        const userId = String(payload.sub || payload.id || "");
        
        const u = await findNeonUser({ 
           ...(userId ? { id: userId } : {}), 
           ...(userEmail ? { email: userEmail } : {}),
        });
        
        const effectiveId = u?.id || userId;
        const effectiveEmail = u?.email || userEmail;
        const effectiveName = u?.name || String(payload.name || userEmail.split("@")[0]);
        const store = await prisma.stores.findFirst({ where: { merchant_id: effectiveId } });

        let role: 'admin' | 'merchant' | 'customer' | null = null;
        if (u?.role === 'admin' || payload.role === 'admin' || effectiveEmail.includes("admin@")) {
            role = 'admin';
        } else if (store || u?.role === 'merchant' || payload.role === 'merchant') {
            role = 'merchant';
        }

        return {
            id: effectiveId,
            email: effectiveEmail,
            name: effectiveName,
            role,
            store_id: role === 'admin' ? null : store?.id || null,
        };
    } catch (error) {
        console.error('Invalid authentication token:', error);
        return null;
    }
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