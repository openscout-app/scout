"""scout-tailscale command line.

Exit codes: 0 ok, 1 failure, 2 usage (including "choose a machine"),
3 TLS pin mismatch (nothing sent), 4 not paired, grant inactive, or the
original grant of an ask is gone.
"""

from __future__ import annotations

import argparse
import email.utils
import json
import platform
import sys
import time

from . import PROTOCOL, __version__
from .core import (GuestClient, ScoutError, Store, client_for_ask, import_bootstrap, machine_label, machines, node_proxy,
                   pair, resolve_machine, state_dir)
from .machines import choose_machine, match_peer, probe_all, sync_directory, tailnet_peers
from .signing import key_id, public_key_b64
from .transport import PinMismatch, TransportError, proxy_for, redact_url


def _emit(args, payload: dict, text: str) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True) if args.json else text)


def _status_payload(store: Store) -> dict:
    """Everything here is safe to show: no private key, device code or proxy secret."""
    state = store.state()
    key = store.key()
    pending = state.get("pending")
    return {
        "version": __version__,
        "protocol": PROTOCOL,
        "stateDir": str(store.root),
        "keyId": key_id(key) if key else None,
        "paired": bool(machines(state)),
        "owner": state.get("owner") or (pending or {}).get("owner"),
        "machines": [{"id": mid, "label": machine_label(entry), "state": entry.get("state"), "endpoint": entry["node"]["endpoint"],
                      "allowedTargets": (entry.get("grant") or {}).get("allowedTargets") or [],
                      "expiresAt": (entry.get("grant") or {}).get("expiresAt")} for mid, entry in sorted(machines(state).items())],
        "preferred": state.get("preferred"),
        "pending": {"owner": pending["owner"], "userCode": pending["userCode"], "expiresAt": pending["expiresAt"]} if pending else None,
        "nodeProxy": redact_url(node_proxy(state)) or "direct",
    }


def cmd_connect(args, store: Store) -> int:
    def show(progress):
        verb = "Still waiting" if progress.resumed else "Requested a direct connection"
        print(f"{verb} to https://oscout.net/{progress.owner}.", file=sys.stderr)
        print(f"Matching code: {progress.user_code}", file=sys.stderr)
        print("The owner approves in Scout on their Mac after checking the code matches.", file=sys.stderr, flush=True)

    if args.bootstrap:
        try:
            with open(args.bootstrap, encoding="utf-8") as handle:
                claim = json.load(handle)
        except (OSError, json.JSONDecodeError) as error:
            raise ScoutError("usage", f"could not read {args.bootstrap}: {error}", 2) from error
        result = import_bootstrap(store, claim, args.node_key or "", endpoint=args.endpoint, proxy=args.proxy)
    elif args.owner:
        result = pair(store, args.owner, args.name, wait=not args.no_wait, on_code=show, proxy=args.proxy)
    else:
        raise ScoutError("usage", "connect needs --owner <profile> or --bootstrap <file> --node-key <id>", 2)
    if result is None:
        _emit(args, {"ok": True, "pending": True, **_status_payload(store)}, "Run the same command without --no-wait to finish.")
        return 0
    node, grant = result["node"], result["grant"]
    # Pairing stored is not a usable connection: only a signed request that
    # the node accepts over the pinned transport counts as connected.
    try:
        GuestClient(store, machine=node["id"]).whoami()
    except (ScoutError, TransportError) as error:
        code = "pin_mismatch" if isinstance(error, PinMismatch) else getattr(error, "code", "transport")
        exit_code = 3 if isinstance(error, PinMismatch) else getattr(error, "exit_code", 1)
        _emit(args, {"ok": False, "paired": True, "verified": False, "error": code, "detail": str(error), "node": node, "grant": grant},
              f"Pairing saved, but NOT connected: {error}\nRun `scout-tailscale doctor` after fixing it.")
        return exit_code
    _emit(args, {"ok": True, "paired": True, "verified": True, "node": node, "grant": grant},
          f"Connected to {node.get('label') or node['id']} at {node['endpoint']} (pinned, signed request accepted).\n"
          "Run it again to request another of the owner's machines; `scout-tailscale machines` lists them.\n"
          f"Allowed agents: {', '.join(grant['allowedTargets']) or '(none)'}. Expires {grant.get('expiresAt')}.")
    return 0


def cmd_key(args, store: Store) -> int:
    """Public half only: this is what the owner enrolls. The private key never leaves state."""
    key = store.key(create=True)
    _emit(args, {"publicKey": public_key_b64(key), "keyId": key_id(key)}, f"public key: {public_key_b64(key)}\nkey id:     {key_id(key)}")
    return 0


def cmd_status(args, store: Store) -> int:
    payload = _status_payload(store)
    if payload["paired"]:
        lines = [f"{'*' if m['id'] == payload['preferred'] else ' '} {m['label']:<20} {m['state']:<9} "
                 f"{', '.join(m['allowedTargets']) or '(no agents)'}  until {m['expiresAt']}" for m in payload["machines"]]
        if payload["pending"]:
            lines.append(f"Waiting for {payload['pending']['owner']} to approve code {payload['pending']['userCode']}.")
        text = "\n".join([f"Owner: {payload['owner'] or '(bootstrap)'}", *lines, f"Key: {payload['keyId']}"])
    elif payload["pending"]:
        text = f"Waiting for {payload['pending']['owner']} to approve code {payload['pending']['userCode']}."
    else:
        text = "Not paired. Run `scout-tailscale connect --owner <profile>`."
    _emit(args, payload, text)
    return 0


def cmd_doctor(args, store: Store) -> int:
    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"check": name, "ok": ok, "detail": detail})

    import cryptography

    check("python", sys.version_info >= (3, 11), platform.python_version())
    check("cryptography", True, cryptography.__version__)
    problems = store.permission_problems()
    check("state permissions", not problems, "; ".join(problems) or f"{store.root} is owner-only")
    state = store.state()
    known = machines(state)
    exit_code = 0
    if not known:
        check("paired", False, "not paired")
        exit_code = 4
    chosen = node_proxy(state)
    for mid in [resolve_machine(state, args.machine)] if args.machine and known else sorted(known):
        entry = known[mid]
        node, name = entry["node"], machine_label(entry)
        ambient = proxy_for(node["endpoint"])
        check(f"{name}: proxy", True, (redact_url(chosen) or "direct") + (
            f" (ambient {redact_url(ambient)} is ignored for node traffic)" if ambient and ambient != chosen else ""))
        if entry.get("state") != "active":
            check(f"{name}: grant", False, f"{entry.get('state')} (reported by the owner's directory)")
            exit_code = exit_code or 4
            continue
        try:
            client = GuestClient(store, machine=mid)
            status, headers, _ = client.endpoint.request("GET", "/v1/node")
            check(f"{name}: pinned TLS", True, f"{client.endpoint.url} presented the pinned key")
            served = headers.get("date")
            if served:
                skew = time.time() - email.utils.parsedate_to_datetime(served).timestamp()
                check(f"{name}: clock skew", abs(skew) < 240, f"{skew:+.0f}s against the node (limit ±300s)")
            card = client.node_card()
            if card["tls"]["spkiFingerprint"] != node["pin"]:
                check(f"{name}: node card", False, "the node now advertises a different TLS key; it must be approved again")
            else:
                def refresh(fresh: dict) -> None:
                    fresh_entry = machines(fresh).get(mid)
                    if fresh_entry and fresh_entry["node"]["keyId"] == node["keyId"]:
                        fresh_entry["node"] = {**fresh_entry["node"], "cardExpiresAt": card["expiresAt"],
                                               "endpoints": card.get("endpoints", node.get("endpoints"))}
                store.update_state(refresh)
                check(f"{name}: node card", True, f"signed by {node['keyId'][:16]}…, fresh")
            whoami = client.whoami()
            check(f"{name}: guest grant", True, f"{whoami['grant']['id']} for {', '.join(whoami['grant']['allowedTargets'])}")
            agents = client.agents()
            check(f"{name}: permitted agents", bool(agents),
                  ", ".join(agent["id"] for agent in agents) if agents else
                  "No approved targets are registered on this machine. Ask the owner to restore the intended agent "
                  "or approve a current target; keep the existing key and pins.")
        except PinMismatch as error:
            check(f"{name}: pinned TLS", False, str(error))
            exit_code = 3
        except (ScoutError, TransportError) as error:
            check(f"{name}: guest API", False, str(error))
            exit_code = exit_code or getattr(error, "exit_code", 1)
    if exit_code == 0 and not all(c["ok"] for c in checks):
        exit_code = 1
    _emit(args, {"ok": exit_code == 0, "checks": checks},
          "\n".join(f"{'ok ' if c['ok'] else 'FAIL'} {c['check']}: {c['detail']}" for c in checks))
    return exit_code


def cmd_machines(args, store: Store) -> int:
    directory = sync_directory(store) if not args.offline else {"ok": False, "error": "skipped", "detail": "--offline"}
    state = store.state()
    known = machines(state)
    probes = probe_all(store, sorted(known)) if not args.no_probe else {}
    tailnet = tailnet_peers()
    peers = tailnet.get("peers", [])
    listed, matched = [], set()
    for mid, entry in sorted(known.items()):
        peer = match_peer(entry, peers)
        if peer:
            matched.add(peer["dnsName"])
        found = probes.get(mid) or {"status": entry.get("state") if entry.get("state") != "active" else "not_probed"}
        listed.append({"id": mid, "label": machine_label(entry), "status": found["status"],
                       "agents": found.get("agents", []), "allowedTargets": (entry.get("grant") or {}).get("allowedTargets") or [],
                       "expiresAt": (entry.get("grant") or {}).get("expiresAt"), "preferred": mid == state.get("preferred"),
                       "tailnet": {"hostName": peer["hostName"], "online": peer["online"]} if peer else None,
                       **({"detail": found["detail"]} if found.get("detail") else {})})
    # Tailnet devices this key has no approved grant on. Absence from this key's
    # directory says nothing about whether Scout runs there.
    others = [{"hostName": p["hostName"], "dnsName": p["dnsName"], "online": p["online"], "scout": "not verified"}
              for p in peers if p["dnsName"] not in matched]
    payload = {"owner": state.get("owner"), "machines": listed, "directory": directory,
               "tailnet": {"available": tailnet["available"], **({"detail": tailnet["detail"]} if "detail" in tailnet else {}),
                           "otherDevices": others}}
    lines = [f"Scout machines{' for ' + state['owner'] if state.get('owner') else ''}:" if listed else "No Scout machines are paired yet."]
    for m in listed:
        agents = ", ".join(a["id"] for a in m["agents"]) if m["agents"] else ", ".join(m["allowedTargets"]) or "-"
        where = f"  tailnet: {m['tailnet']['hostName']} {'online' if m['tailnet']['online'] else 'offline'}" if m["tailnet"] else ""
        lines.append(f"{'*' if m['preferred'] else ' '} {m['label']:<20} {m['status']:<14} {agents}{where}")
    if directory.get("ok") and directory.get("pending"):
        lines.append(f"  {directory['pending']} request(s) still waiting for the owner's approval")
    elif not directory.get("ok") and directory.get("error") != "skipped":
        lines.append(f"  (owner directory unavailable: {directory.get('detail')}; showing saved machines)")
    if others:
        lines.append("Other tailnet devices (no approved Scout connection for this key; Scout not verified):")
        lines += [f"  {o['hostName'] or o['dnsName']:<20} {'online' if o['online'] else 'offline'}" for o in others]
    elif not tailnet["available"]:
        lines.append(f"Tailnet devices: not listed ({tailnet.get('detail')})")
    _emit(args, payload, "\n".join(lines))
    return 0


def cmd_use(args, store: Store) -> int:
    state = store.state()
    if args.clear:
        store.update_state(lambda current: {k: v for k, v in current.items() if k != "preferred"})
        _emit(args, {"ok": True, "preferred": None}, "No remembered machine; asks choose automatically when only one fits.")
        return 0
    if not args.machine:
        raise ScoutError("usage", "use needs a machine name (or --clear)", 2)
    machine = resolve_machine(state, args.machine)
    store.update_state(lambda current: {**current, "preferred": machine})
    label = machine_label(machines(state)[machine])
    _emit(args, {"ok": True, "preferred": machine}, f"New asks go to {label} when its grant allows the agent.")
    return 0


def cmd_who(args, store: Store) -> int:
    state = store.state()
    known = machines(state)
    ids = [resolve_machine(state, args.machine)] if args.machine else sorted(known)
    if not known:
        raise ScoutError("not_paired", "not paired; run `scout-tailscale connect --owner <profile>`", 4)
    probes = probe_all(store, ids)
    agents = [{**agent, "machine": mid, "machineLabel": machine_label(known[mid])}
              for mid in ids for agent in probes[mid].get("agents", [])]
    if args.query:
        wanted = args.query.lower()
        agents = [a for a in agents if wanted in a["id"].lower() or wanted in (a.get("displayName") or "").lower()]
    unavailable = {mid: p["status"] for mid, p in probes.items() if p["status"] != "available"}
    lines = [f"{a['id']:<24} {a.get('displayName', ''):<24} on {a['machineLabel']}" for a in agents] or ["No reachable agents."]
    lines += [f"({machine_label(known[mid])}: {status})" for mid, status in unavailable.items()]
    _emit(args, {"agents": agents, "unavailable": unavailable}, "\n".join(lines))
    if any(p["status"] == "available" for p in probes.values()):
        return 0
    statuses = set(unavailable.values())
    return 3 if "pin_mismatch" in statuses else 4 if statuses <= {"grant_inactive", "revoked", "revoking", "expired", "denied"} else 1


def _render_ask(result: dict) -> str:
    lines = [f"{result.get('requestId')}: {result.get('state')}" + (f" on {result['machine']}" if result.get("machine") else "")]
    for field in ("output", "summary", "error"):
        if result.get(field):
            lines.append(str(result[field]))
    return "\n".join(lines)


def cmd_ask(args, store: Store) -> int:
    if args.resume:
        # Same machine, node key and grant as the first send, or an honest failure.
        client = client_for_ask(store, args.resume)
        result = client.resume(args.resume)
    else:
        if not args.to or args.task is None:
            raise ScoutError("usage", "ask needs --to <agent> and a task (or --resume <requestId>)", 2)
        if args.request_id and args.request_id in store.asks():
            client = client_for_ask(store, args.request_id)
        else:
            machine, _ = choose_machine(store, args.to, args.machine)
            client = GuestClient(store, machine=machine)
        task = sys.stdin.read() if args.task == "-" else args.task
        result = client.ask(args.to, task, args.request_id)
    if args.wait > 0 and result.get("state") not in ("completed", "failed", "cancelled"):
        result = client.wait(result["requestId"], args.wait)
    _emit(args, result, _render_ask(result))
    return 0 if result.get("state") != "failed" else 1


def cmd_wait(args, store: Store) -> int:
    client = client_for_ask(store, args.request_id) if args.request_id in store.asks() else GuestClient(store, machine=args.machine)
    result = client.wait(args.request_id, args.timeout)
    _emit(args, result, _render_ask(result))
    return 0 if result.get("state") != "failed" else 1


def cmd_disconnect(args, store: Store) -> int:
    if args.machine:
        state = store.state()
        machine = resolve_machine(state, args.machine)
        store.update_state(lambda current: {
            **{k: v for k, v in current.items() if not (k == "preferred" and v == machine)},
            "machines": {mid: entry for mid, entry in machines(current).items() if mid != machine}})
        _emit(args, {"ok": True, "removed": machine}, f"Forgot {machine} here. The owner can revoke its grant from Scout on that Mac.")
        return 0
    store.clear(keep_key=args.keep_key)
    _emit(args, {"ok": True}, "Removed local pairing state. The owner can revoke grants from Scout on their Macs.")
    return 0


def cmd_session(args, store: Store) -> int:
    if args.action == "attach":
        client = GuestClient(store, machine=args.machine)
        result = client.attach_session(args.native_session)
    else:
        origin = store._read("sessions.json").get(args.session)
        if not origin:
            raise ScoutError("unknown_session", "attach this session first; its origin is not saved", 4)
        client = GuestClient(store, machine=origin["node"])
        fields = {}
        if args.action in ("ack", "reply"):
            fields["deliveryId"] = args.delivery
        if args.action == "reply":
            try:
                with open(args.body_file, encoding="utf-8") as handle:
                    fields["body"] = handle.read(100_001)
            except OSError as error:
                raise ScoutError("usage", f"cannot read reply file: {error}", 2) from error
        result = client.session_action(args.action, args.session, **fields)
    _emit(args, result, json.dumps(result, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="scout-tailscale", description="Direct, owner-approved access to Scout machines on your tailnet.")
    parser.add_argument("--version", action="version", version=f"scout-tailscale {__version__} ({PROTOCOL})")
    parser.add_argument("--json", action="store_true", help="machine-readable output (secrets redacted)")
    sub = parser.add_subparsers(dest="command", required=True)

    connect = sub.add_parser("connect", help="request access from a profile owner and pair")
    connect.add_argument("--owner", help="profile, e.g. https://oscout.net/arach")
    connect.add_argument("--bootstrap", help="pair from a bootstrap file delivered out of band")
    connect.add_argument("--node-key", help="with --bootstrap: the node key id, from a separate trusted channel")
    connect.add_argument("--endpoint", help="one of the endpoints the node's signed card lists")
    connect.add_argument("--name", default=platform.node().split(".")[0].lower() or "scout-guest", help="how you appear to the owner")
    connect.add_argument("--no-wait", action="store_true", help="print the matching code and return")
    connect.add_argument("--proxy", help="HTTP CONNECT proxy that reaches the tailnet (saved; ambient HTTPS_PROXY is not used for node traffic)")
    connect.set_defaults(run=cmd_connect)

    sub.add_parser("key", help="create (once) and print this client's public key").set_defaults(run=cmd_key)
    sub.add_parser("status", help="show pairing state").set_defaults(run=cmd_status)
    doctor = sub.add_parser("doctor", help="check pin, clock, card and grant on each machine")
    doctor.add_argument("--machine", help="check one machine")
    doctor.set_defaults(run=cmd_doctor)

    listing = sub.add_parser("machines", help="discover approved Scout machines, their availability and agents")
    listing.add_argument("--offline", action="store_true", help="skip the owner directory; use saved machines")
    listing.add_argument("--no-probe", action="store_true", help="do not contact the machines")
    listing.set_defaults(run=cmd_machines)

    use = sub.add_parser("use", help="remember which machine new asks go to")
    use.add_argument("machine", nargs="?", help="machine name or node id")
    use.add_argument("--clear", action="store_true")
    use.set_defaults(run=cmd_use)

    who = sub.add_parser("who", help="list agents you can ask, on every reachable machine")
    who.add_argument("query", nargs="?")
    who.add_argument("--machine", help="only this machine")
    who.set_defaults(run=cmd_who)

    ask = sub.add_parser("ask", help="ask an allowed agent")
    ask.add_argument("--to", help="exact agent id")
    ask.add_argument("--machine", help="machine for a new ask (remembered); default: the only one that fits")
    ask.add_argument("--request-id", help="idempotency key (default: generated and journaled)")
    ask.add_argument("--resume", metavar="REQUEST_ID", help="resend a journaled ask after a lost response")
    ask.add_argument("--wait", type=float, default=0, help="seconds to wait for the answer")
    ask.add_argument("task", nargs="?", help="the task, or - to read stdin")
    ask.set_defaults(run=cmd_ask)

    wait = sub.add_parser("wait", help="wait for an ask's result")
    wait.add_argument("request_id")
    wait.add_argument("--timeout", type=float, default=120)
    wait.add_argument("--machine", help="for an ask not in this journal")
    wait.set_defaults(run=cmd_wait)

    session = sub.add_parser("session", help="receive assignments and reply through a Scout mailbox (no automatic wake)")
    actions = session.add_subparsers(dest="action", required=True)
    attach = actions.add_parser("attach", help="attach a stable native conversation to this grant")
    attach.add_argument("--native-session", required=True)
    attach.add_argument("--machine", required=True, help="explicit originating Scout machine")
    attach.set_defaults(run=cmd_session)
    for action in ("get", "poll", "ack", "reply"):
        command = actions.add_parser(action)
        command.add_argument("--session", required=True)
        if action in ("ack", "reply"):
            command.add_argument("--delivery", required=True)
        if action == "reply":
            command.add_argument("--body-file", required=True, help="UTF-8 reply file; content stays out of command arguments")
        command.set_defaults(run=cmd_session)

    disconnect = sub.add_parser("disconnect", help="forget the pairing on this machine")
    disconnect.add_argument("--keep-key", action="store_true")
    disconnect.add_argument("--machine", help="forget only this machine")
    disconnect.set_defaults(run=cmd_disconnect)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    store = Store(state_dir())
    try:
        return args.run(args, store)
    except PinMismatch as error:
        _fail(args, "pin_mismatch", str(error))
        return 3
    except TransportError as error:
        _fail(args, "transport", str(error))
        return 1
    except ScoutError as error:
        _fail(args, error.code, str(error), error.details)
        return error.exit_code
    except KeyboardInterrupt:
        return 130


def _fail(args, code: str, message: str, details: dict | None = None) -> None:
    if args.json:
        print(json.dumps({"ok": False, "error": code, "detail": message, **(details or {})}, indent=2))
    else:
        print(f"scout-tailscale: {message}", file=sys.stderr)
