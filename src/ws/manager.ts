import type { WebSocket } from "ws";
import type {
  WsMessage,
  SubscribePayload,
  UnsubscribePayload,
  EventPayload,
  SessionUpdatePayload,
  PerformancePayload,
  ErrorPayload,
} from "./types";
import type { AppEvent, Session } from "../types";

interface Connection {
  ws: WebSocket;
  subscribedSessions: Set<string>;
  lastHeartbeat: number;
  alive: boolean;
}

export class ConnectionManager {
  private connections = new Map<string, Connection>();
  private sessionSubscriptions = new Map<string, Set<string>>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private performanceInterval: ReturnType<typeof setInterval> | null = null;
  private eventCount = 0;
  private eventCountResetTime = Date.now();

  constructor() {
    this.startHeartbeat();
    this.startPerformanceReporting();
  }

  addConnection(ws: WebSocket): string {
    const id = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const connection: Connection = {
      ws,
      subscribedSessions: new Set(),
      lastHeartbeat: Date.now(),
      alive: true,
    };
    this.connections.set(id, connection);

    ws.on("close", () => this.removeConnection(id));
    ws.on("pong", () => this.onPong(id));

    return id;
  }

  removeConnection(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;

    conn.alive = false;
    for (const sessionId of conn.subscribedSessions) {
      this.unsubscribeSession(id, sessionId);
    }
    this.connections.delete(id);
  }

  subscribeSession(connectionId: string, sessionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    conn.subscribedSessions.add(sessionId);

    let subscribers = this.sessionSubscriptions.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.sessionSubscriptions.set(sessionId, subscribers);
    }
    subscribers.add(connectionId);
  }

  unsubscribeSession(connectionId: string, sessionId: string): void {
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.subscribedSessions.delete(sessionId);
    }

    const subscribers = this.sessionSubscriptions.get(sessionId);
    if (subscribers) {
      subscribers.delete(connectionId);
      if (subscribers.size === 0) {
        this.sessionSubscriptions.delete(sessionId);
      }
    }
  }

  unsubscribeAll(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    for (const sessionId of conn.subscribedSessions) {
      this.unsubscribeSession(connectionId, sessionId);
    }
    conn.subscribedSessions.clear();
  }

  broadcastEvent(event: AppEvent): void {
    this.eventCount++;
    const subscribers = this.sessionSubscriptions.get(event.sessionId);
    if (!subscribers) return;

    const message: WsMessage<EventPayload> = {
      type: "event",
      payload: { event },
    };

    for (const connId of subscribers) {
      this.sendToConnection(connId, message);
    }
  }

  broadcastSessionUpdate(session: Session): void {
    const subscribers = this.sessionSubscriptions.get(session.id);
    if (!subscribers) return;

    const message: WsMessage<SessionUpdatePayload> = {
      type: "session-update",
      payload: { session },
    };

    for (const connId of subscribers) {
      this.sendToConnection(connId, message);
    }
  }

  sendToConnection(connectionId: string, message: WsMessage): void {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.alive) return;

    try {
      conn.ws.send(JSON.stringify(message));
    } catch {
      this.removeConnection(connectionId);
    }
  }

  sendError(connectionId: string, code: string, message: string): void {
    const errorMessage: WsMessage<ErrorPayload> = {
      type: "error",
      payload: { code, message },
    };
    this.sendToConnection(connectionId, errorMessage);
  }

  handleMessage(connectionId: string, data: string): void {
    try {
      const message: WsMessage = JSON.parse(data);

      switch (message.type) {
        case "subscribe": {
          const payload = message.payload as SubscribePayload;
          if (payload.sessionId) {
            this.subscribeSession(connectionId, payload.sessionId);
          }
          break;
        }
        case "unsubscribe": {
          const payload = message.payload as UnsubscribePayload;
          if (payload.sessionId) {
            this.unsubscribeSession(connectionId, payload.sessionId);
          } else {
            this.unsubscribeAll(connectionId);
          }
          break;
        }
        case "heartbeat": {
          const conn = this.connections.get(connectionId);
          if (conn) {
            conn.lastHeartbeat = Date.now();
          }
          break;
        }
      }
    } catch {
      this.sendError(connectionId, "INVALID_MESSAGE", "无法解析消息");
    }
  }

  private onPong(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.lastHeartbeat = Date.now();
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 30_000;

      for (const [id, conn] of this.connections) {
        if (!conn.alive) continue;

        if (now - conn.lastHeartbeat > timeout) {
          conn.alive = false;
          conn.ws.terminate();
          this.removeConnection(id);
        } else {
          conn.ws.ping();
        }
      }
    }, 10_000);
  }

  private startPerformanceReporting(): void {
    this.performanceInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.eventCountResetTime;
      const eventRate = elapsed > 0 ? (this.eventCount / elapsed) * 1000 : 0;

      const subscriptions: Record<string, number> = {};
      for (const [sessionId, subscribers] of this.sessionSubscriptions) {
        subscriptions[sessionId] = subscribers.size;
      }

      const message: WsMessage<PerformancePayload> = {
        type: "performance",
        payload: {
          timestamp: now,
          connectionCount: this.connections.size,
          eventRate,
          subscriptions,
        },
      };

      for (const id of this.connections.keys()) {
        this.sendToConnection(id, message);
      }

      this.eventCount = 0;
      this.eventCountResetTime = now;
    }, 5_000);
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getSubscriptionCount(sessionId?: string): number {
    if (sessionId) {
      return this.sessionSubscriptions.get(sessionId)?.size ?? 0;
    }
    let total = 0;
    for (const subscribers of this.sessionSubscriptions.values()) {
      total += subscribers.size;
    }
    return total;
  }

  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.performanceInterval) {
      clearInterval(this.performanceInterval);
    }
    for (const conn of this.connections.values()) {
      conn.ws.close();
    }
    this.connections.clear();
    this.sessionSubscriptions.clear();
  }
}