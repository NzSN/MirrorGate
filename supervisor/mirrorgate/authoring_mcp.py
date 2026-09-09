#!/usr/bin/env python3
"""Public-only MCP adapter for a trusted evaluator's Gate authoring broker.

This host process exposes no local filesystem, shell, network, or model API
operation to the author. All author commands are forwarded to one fixed broker.
"""
import argparse
import json
import socket
import sys

MAX_FRAME = 1048576


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def broker_request(path, request):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(90)
        connection.connect(path)
        connection.sendall((json.dumps(request, ensure_ascii=True) + "\n").encode())
        with connection.makefile("rb") as stream:
            line = stream.readline(MAX_FRAME + 1)
        if not line.endswith(b"\n") or len(line) > MAX_FRAME:
            raise ValueError("invalid broker response")
        result = json.loads(line, object_pairs_hook=strict_object)
        if not isinstance(result, dict) or result.get("id") != request["id"]:
            raise ValueError("uncorrelated broker response")
        return result


# This entry point is invoked by absolute path from a pinned private runtime tree.
from authoring_broker import tool_definitions
TOOLS = tool_definitions()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--broker", required=True)
    parser.add_argument("--token", required=True)
    options = parser.parse_args()
    counter = 0
    while True:
        raw = sys.stdin.buffer.readline(MAX_FRAME + 1)
        if not raw:
            return
        if len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
            raise SystemExit("invalid MCP frame")
        request = json.loads(raw, object_pairs_hook=strict_object)
        if type(request) is not dict or request.get("jsonrpc") != "2.0" or set(request) - {"jsonrpc", "id", "method", "params"}:
            raise SystemExit("invalid MCP request")
        if "id" not in request:
            continue
        response = {"jsonrpc": "2.0", "id": request["id"]}
        method = request.get("method")
        try:
            if method == "initialize":
                response["result"] = {
                    "protocolVersion": request.get("params", {}).get("protocolVersion", "2024-11-05"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "gate-author-only", "version": "2.0.0"},
                }
            elif method == "ping":
                response["result"] = {}
            elif method == "tools/list":
                response["result"] = {"tools": TOOLS}
            elif method == "resources/list":
                response["result"] = {"resources": []}
            elif method == "resources/templates/list":
                response["result"] = {"resourceTemplates": []}
            elif method == "prompts/list":
                response["result"] = {"prompts": []}
            elif method == "tools/call":
                params = request.get("params", {})
                name = params.get("name")
                arguments = params.get("arguments", {})
                if not isinstance(arguments, dict):
                    raise ValueError("invalid arguments")
                counter += 1
                call = {"id": counter, "token": options.token}
                if name == "gate_exec":
                    if set(arguments) != {"toolId", "args"} or type(arguments["toolId"]) is not str:
                        raise ValueError("unknown authoring operation")
                    args = arguments["args"]
                    if not isinstance(args, list) or len(args) > 128 or any(not isinstance(x, str) or not x or "\0" in x for x in args):
                        raise ValueError("invalid authoring arguments")
                    if sum(len(x.encode()) for x in args) > 60000:
                        raise ValueError("authoring arguments exceed limit")
                    call.update({"op": "exec", **arguments})
                elif name in ("public_contract", "submit") and not arguments:
                    call["op"] = "contract" if name == "public_contract" else "submit"
                else:
                    raise ValueError("unknown authoring operation")
                result = broker_request(options.broker, call)
                response["result"] = {
                    "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=True)}],
                    "isError": result.get("ok") is False,
                }
            else:
                response["error"] = {"code": -32601, "message": "operation not available"}
        except Exception:
            # Never disclose a broker address, stack, control error, or host path.
            response["error"] = {"code": -32602, "message": "authoring request failed"}
        sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
