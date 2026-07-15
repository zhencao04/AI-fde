import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "node:http";
import { ConnectionManager } from "./manager";

export class WsServer {
  private wss: WebSocketServer | null = null;
  private manager: ConnectionManager;
  private connectionMap = new Map<WebSocket, string>();

  constructor() {
    this.manager = new ConnectionManager();
  }

  attachToHttpServer(httpServer: Server): void {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: "/api/ws",
    });

    this.wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const sessionId = url.searchParams.get("sessionId");

      const connectionId = this.manager.addConnection(ws);
      this.connectionMap.set(ws, connectionId);

      if (sessionId) {
        this.manager.subscribeSession(connectionId, sessionId);
      }

      ws.on("message", (data: Buffer | string) => {
        this.manager.handleMessage(connectionId, data.toString());
      });

      ws.on("close", () => {
        this.connectionMap.delete(ws);
      });
    });
  }

  broadcastEvent(event: Parameters<ConnectionManager["broadcastEvent"]>[0]): void {
    this.manager.broadcastEvent(event);
  }

  broadcastSessionUpdate(session: Parameters<ConnectionManager["broadcastSessionUpdate"]>[0]): void {
    this.manager.broadcastSessionUpdate(session);
  }

  getConnectionCount(): number {
    return this.manager.getConnectionCount();
  }

  getSubscriptionCount(sessionId?: string): number {
    return this.manager.getSubscriptionCount(sessionId);
  }

  shutdown(): void {
    this.manager.shutdown();
    if (this.wss) {
      this.wss.close();
    }
  }
}