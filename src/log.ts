import pino from "pino";
import { config } from "./config.js";

export const log = pino({
  level: config.LOG_LEVEL,
  transport:
    config.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
});
