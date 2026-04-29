import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

export function stripHtmlTags(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isUnknownAuthor(authors?: string[] | null): boolean {
  if (!authors || authors.length === 0) return true;
  return authors.every((a) => !a || a.trim().toLowerCase() === "unknown");
}

export function coverInitials(title: string): string {
  const cleaned = title.replace(/[^A-Za-z0-9]+/g, " ").trim();
  if (!cleaned) return "?";
  const words = cleaned.split(" ");
  const first = words[0];
  const second = words[1];
  if (first && second && first[0] && second[0]) {
    return (first[0] + second[0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}
