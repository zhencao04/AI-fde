import type { AppEvent, Session } from "../types";

export type WsMessageType =
  | "subscribe"
  | "unsubscribe"
  | "heartbeat"
  | "event"
  | "session-update"
  | "performance"
  | "error";

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload: T;
}

export interface SubscribePayload {
  sessionId: string;
}

export interface UnsubscribePayload {
  sessionId?: string;
}

export interface HeartbeatPayload {
  timestamp: number;
}

export interface EventPayload {
  event: AppEvent;
}

export interface SessionUpdatePayload {
  session: Session;
}

export interface PerformancePayload {
  timestamp: number;
  connectionCount: number;
  eventRate: number;
  subscriptions: Record<string, number>;
}

export interface ErrorPayload {
  code: string;
  message: string;
}