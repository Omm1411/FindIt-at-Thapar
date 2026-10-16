
import "dotenv/config";
import { supabase } from "./lib/supabase.js";

const { data, error } = await supabase
  .from("items")
  .select("id")
  .limit(1);

if (error) {
  console.error("Database connection failed:", error.message);
  process.exitCode = 1;
} else {
  console.log("Supabase connected successfully!");
  console.log("Database query completed.");
}
