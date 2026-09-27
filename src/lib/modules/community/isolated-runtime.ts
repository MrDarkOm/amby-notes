import type { RpcRequest, RpcResponse } from "./types"

export interface PluginExecutionResult {
  success: boolean
  result?: unknown
  error?: string
}

const WORKER_BOOTSTRAP = `
const isNode = typeof process !== "undefined" && process.versions && process.versions.node;
let sendToHost;

if (isNode) {
  const { parentPort } = require("worker_threads");
  sendToHost = (msg) => parentPort.postMessage(msg);
  parentPort.on("message", (msg) => handleHostMessage(msg));
} else {
  sendToHost = (msg) => postMessage(msg);
  addEventListener("message", (e) => handleHostMessage(e.data));
}

const pendingRpc = new Map();

function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    const id = "rpc_" + Math.random().toString(36).slice(2) + Date.now();
    pendingRpc.set(id, { resolve, reject });
    sendToHost({ type: "rpc_request", id, method, params });
  });
}

const ambyApi = {
  vault: {
    readFile: (relPath) => rpcCall("vault.readFile", { relPath }),
    writeFile: (relPath, content) => rpcCall("vault.writeFile", { relPath, content }),
  },
  network: {
    fetch: (url, opts) => rpcCall("network.fetch", { url, ...(opts || {}) }),
  },
  clipboard: {
    readText: () => rpcCall("clipboard.read", {}),
    writeText: (text) => rpcCall("clipboard.write", { text }),
  },
  notify: (message) => rpcCall("workspace.notify", { message }),
};

async function handleHostMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "rpc_response") {
    const pending = pendingRpc.get(msg.id);
    if (pending) {
      pendingRpc.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || msg.error.code || "RPC failed"));
      } else {
        pending.resolve(msg.result);
      }
    }
  } else if (msg.type === "execute") {
    try {
      // Execute plugin code inside an isolated AsyncFunction scope with 'amby' as the sole injected parameter
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunction("amby", msg.code);
      const result = await fn(ambyApi);
      sendToHost({ type: "execute_done", result });
    } catch (err) {
      sendToHost({
        type: "execute_error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
`

export type RpcHandler = (request: RpcRequest) => Promise<RpcResponse>

export class IsolatedPluginRuntime {
  private worker: {
    postMessage: (msg: unknown) => void
    terminate: () => void
  } | null = null
  private isTerminated = false
  private pendingExecution: {
    resolve: (res: PluginExecutionResult) => void
    reject: (err: Error) => void
  } | null = null

  async init(rpcHandler: RpcHandler): Promise<void> {
    const isNode = typeof window === "undefined"

    if (isNode) {
      const modName = "node:worker_threads"
      const { Worker } = (await import(/* @vite-ignore */ modName)) as {
        Worker: new (
          code: string,
          opts: { eval: boolean },
        ) => {
          postMessage: (msg: unknown) => void
          on: (event: string, cb: (msg: unknown) => void) => void
          terminate: () => void
        }
      }
      const nodeWorker = new Worker(WORKER_BOOTSTRAP, { eval: true })
      nodeWorker.on("message", (msg: unknown) => {
        void this.handleWorkerMessage(msg, rpcHandler)
      })
      this.worker = nodeWorker
    } else {
      const blob = new Blob([WORKER_BOOTSTRAP], { type: "application/javascript" })
      const url = URL.createObjectURL(blob)
      const browserWorker = new Worker(url)
      browserWorker.onmessage = (event) => {
        void this.handleWorkerMessage(event.data, rpcHandler)
      }
      this.worker = {
        postMessage: (msg: unknown) => browserWorker.postMessage(msg),
        terminate: () => {
          browserWorker.terminate()
          URL.revokeObjectURL(url)
        },
      }
    }
  }

  private async handleWorkerMessage(msg: unknown, rpcHandler: RpcHandler): Promise<void> {
    if (!msg || typeof msg !== "object") return
    const data = msg as Record<string, unknown>

    if (data.type === "rpc_request") {
      const rpcReq: RpcRequest = {
        id: String(data.id),
        method: String(data.method) as import("./types").SandboxRpcMethod,
        params: (data.params as Record<string, unknown>) ?? {},
      }
      const rpcRes = await rpcHandler(rpcReq)
      this.worker?.postMessage({
        type: "rpc_response",
        id: rpcRes.id,
        result: rpcRes.result,
        error: rpcRes.error,
      })
    } else if (data.type === "execute_done") {
      this.pendingExecution?.resolve({ success: true, result: data.result })
      this.pendingExecution = null
    } else if (data.type === "execute_error") {
      this.pendingExecution?.resolve({ success: false, error: String(data.error) })
      this.pendingExecution = null
    }
  }

  executeCode(code: string, timeoutMs = 5000): Promise<PluginExecutionResult> {
    if (this.isTerminated || !this.worker) {
      return Promise.resolve({ success: false, error: "Runtime is not running or terminated" })
    }

    return new Promise<PluginExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.terminate()
        resolve({ success: false, error: "Execution timed out" })
      }, timeoutMs)

      this.pendingExecution = {
        resolve: (res) => {
          clearTimeout(timer)
          resolve(res)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      }

      this.worker?.postMessage({ type: "execute", code })
    })
  }

  terminate(): void {
    if (this.isTerminated) return
    this.isTerminated = true
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    if (this.pendingExecution) {
      this.pendingExecution.resolve({ success: false, error: "Runtime terminated" })
      this.pendingExecution = null
    }
  }
}
