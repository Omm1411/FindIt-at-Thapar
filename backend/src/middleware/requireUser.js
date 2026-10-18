import { supabase } from "../lib/supabase.js";

export function createRequireUser(db = supabase) {
  return async function requireUser(req, res, next) {
    const authorization = req.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";

    if (!token) {
      return res.status(401).json({ error: "Please sign in to perform this action." });
    }

    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({ error: "Your session is invalid or expired. Please sign in again." });
    }
    req.user = data.user;
    return next();
  };
}

export const requireUser = createRequireUser();
