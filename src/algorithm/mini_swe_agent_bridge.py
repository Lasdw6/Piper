import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any

os.environ.setdefault("MSWEA_SILENT_STARTUP", "1")

import litellm
import yaml
from minisweagent import package_dir
from minisweagent.agents.default import DefaultAgent
from minisweagent.environments.docker import DockerEnvironment
from minisweagent.environments.local import LocalEnvironment
from minisweagent.models import get_model
from minisweagent.models.litellm_model import LitellmModel

try:
    from openai import OpenAI
except Exception:  # pragma: no cover - optional dependency fallback
    OpenAI = None

litellm.suppress_debug_info = True


class CompressedLitellmModel(LitellmModel):
    def __init__(self, *args, compression=None, summary_model_name=None, summary_model_kwargs=None, **kwargs):
        if "model_name" in kwargs:
            kwargs["model_name"] = _normalize_provider_model_name(kwargs["model_name"])
        passthrough_config = {
            "model_name": kwargs.get("model_name"),
            "model_kwargs": dict(kwargs.get("model_kwargs", {}) or {}),
        }
        super().__init__(*args, **kwargs)
        self._passthrough_model = get_model(passthrough_config["model_name"], config=passthrough_config)
        self.compression = compression or {}
        self.max_context_tokens = int(self.compression.get("maxContextTokens", 24000))
        self.compress_ratio = float(self.compression.get("compressAtRatio", 0.8))
        self.decay_warm_start_tokens = int(
            self.compression.get("decayWarmStartTokens", int(self.max_context_tokens * self.compress_ratio))
        )
        self.decay_target_tokens = int(
            self.compression.get("decayTargetTokens", int(self.max_context_tokens * min(0.95, self.compress_ratio + 0.05)))
        )
        self.recent_raw_window_tokens = int(
            self.compression.get("recentRawWindowTokens", int(self.max_context_tokens * 0.4))
        )
        self.decay_emergency_tokens = int(
            self.compression.get("decayEmergencyTokens", int(self.max_context_tokens * 0.95))
        )
        self.keep_prefix = int(self.compression.get("keepPrefixMessages", 2))
        self.keep_suffix = int(self.compression.get("keepSuffixMessages", 6))
        self.retrieval_top_k = int(self.compression.get("retrievalTopK", 2))
        self.phase_enabled = bool(self.compression.get("phaseCompressionEnabled", True))
        self.message_decay_enabled = bool(self.compression.get("messageDecayEnabled", True))
        self.tool_microcompact_enabled = bool(self.compression.get("toolMicrocompactEnabled", False))
        self.tool_microcompact_threshold_tokens = int(
            self.compression.get(
                "toolMicrocompactThresholdTokens",
                max(1, int(self.max_context_tokens * 0.5)),
            )
        )
        self.tool_microcompact_keep_recent_tool_messages = int(
            self.compression.get("toolMicrocompactKeepRecentToolMessages", 4)
        )
        self.tool_microcompact_min_message_tokens = int(
            self.compression.get("toolMicrocompactMinMessageTokens", 120)
        )
        self.tool_microcompact_min_message_chars = int(
            self.compression.get("toolMicrocompactMinMessageChars", 600)
        )
        self.tool_microcompact_stub = str(
            self.compression.get("toolMicrocompactStub", "[Old tool result content cleared]")
        )
        self.phase_compression_roles = {
            str(role) for role in self.compression.get("phaseCompressionRoles", ["tool"])
        }
        self.decay_candidate_roles = {
            str(role) for role in self.compression.get("decayCandidateRoles", ["tool"])
        }
        self.max_api_calls = int(self.compression.get("maxApiCalls", 0))
        self.max_retrieval_count = int(self.compression.get("maxRetrievalCount", 0))
        self.max_summary_calls = int(self.compression.get("maxSummaryCalls", 0))
        self.max_archive_records = int(self.compression.get("maxArchiveRecords", 0))
        self.max_repeated_prompt_fingerprints = int(self.compression.get("maxRepeatedPromptFingerprints", 0))
        self.main_tpm_limit = int(self.compression.get("mainTpmLimit", 0))
        self.main_tpm_reserve_tokens = int(self.compression.get("mainTpmReserveTokens", 1200))
        self.summary_model_name = _normalize_provider_model_name(
            summary_model_name or self.compression.get("summarizerModel")
        )
        self.summary_model_kwargs = dict(summary_model_kwargs or {})
        self.summary_model_kwargs.setdefault("temperature", 0)
        self.summary_model_kwargs.setdefault("max_tokens", 60)
        self.archive = []
        self._seen = set()
        self._summary_cache = {}
        self._prompt_fingerprints = []
        self._tpm_window = []
        self.summary_turns = []
        self.compression_decisions = []
        self.compression_stats = {
            "microcompacted_count": 0,
            "archived_count": 0,
            "retrieval_count": 0,
            "compress_invocations": 0,
            "summary_call_count": 0,
        }

    def query(self, messages, **kwargs):
        raw_tokens = sum(_estimate_tokens(_message_text(message)) for message in messages)
        if self._should_passthrough(messages, raw_tokens):
            response = self._passthrough_model.query(messages, **kwargs)
            response.setdefault("extra", {})["compression"] = {
                "microcompacted_count": self.compression_stats["microcompacted_count"],
                "archived_count": self.compression_stats["archived_count"],
                "retrieval_count": self.compression_stats["retrieval_count"],
                "compress_invocations": self.compression_stats["compress_invocations"],
                "passthrough": True,
            }
            return response
        prepared, changed = self._compress_messages(messages)
        if not changed:
            response = self._passthrough_model.query(messages, **kwargs)
            response.setdefault("extra", {})["compression"] = {
                "microcompacted_count": self.compression_stats["microcompacted_count"],
                "archived_count": self.compression_stats["archived_count"],
                "retrieval_count": self.compression_stats["retrieval_count"],
                "compress_invocations": self.compression_stats["compress_invocations"],
                "passthrough": True,
                "inspectedOnly": True,
            }
            return response
        self._guard_before_query(prepared)
        self._throttle_main_query(prepared)
        response = super().query(prepared, **kwargs)
        response.setdefault("extra", {})["compression"] = {
            "microcompacted_count": self.compression_stats["microcompacted_count"],
            "archived_count": self.compression_stats["archived_count"],
            "retrieval_count": self.compression_stats["retrieval_count"],
            "compress_invocations": self.compression_stats["compress_invocations"],
            "passthrough": False,
        }
        return response

    def _should_passthrough(self, messages, raw_tokens):
        if len(messages) <= self.keep_prefix + self.keep_suffix:
            return True
        if self.tool_microcompact_enabled and raw_tokens >= self.tool_microcompact_threshold_tokens:
            return False
        threshold = int(self.max_context_tokens * self.compress_ratio)
        if raw_tokens > threshold:
            return False
        return True

    def _compress_messages(self, messages):
        threshold = int(self.max_context_tokens * self.compress_ratio)
        original_raw_tokens = sum(_estimate_tokens(_message_text(message)) for message in messages)
        raw_tokens = original_raw_tokens
        microcompacted_messages = 0
        prepared_messages = list(messages)
        if (
            self.tool_microcompact_enabled
            and len(messages) > self.keep_prefix + self.keep_suffix
            and raw_tokens >= self.tool_microcompact_threshold_tokens
        ):
            prepared_messages, microcompacted_messages = self._apply_tool_microcompact(prepared_messages)
            if microcompacted_messages:
                raw_tokens = sum(_estimate_tokens(_message_text(message)) for message in prepared_messages)
        if raw_tokens <= threshold or len(messages) <= self.keep_prefix + self.keep_suffix:
            changed = _messages_changed(messages, prepared_messages)
            if changed:
                self.compression_stats["compress_invocations"] += 1
            self._record_compression_decision(
                raw_tokens=raw_tokens,
                threshold=threshold,
                phase_active=False,
                recall_used=False,
                candidate_tokens=raw_tokens,
                decay_applied=False,
                decayed_messages=0,
                microcompacted_messages=microcompacted_messages,
                original_tokens=original_raw_tokens,
            )
            return prepared_messages, changed

        prefix = list(prepared_messages[: self.keep_prefix])
        middle = list(prepared_messages[self.keep_prefix : -self.keep_suffix])
        suffix = list(prepared_messages[-self.keep_suffix :])
        compressed_middle = list(middle)

        phase_activation_tokens = self.decay_target_tokens if self.message_decay_enabled else threshold
        phase_active = self.phase_enabled and (
            not self.message_decay_enabled or raw_tokens >= phase_activation_tokens
        )
        if phase_active:
            compressed_middle = []
            for message in middle:
                role = message.get("role", "")
                content = _prepare_content_for_memory(role, _message_text(message))
                if self.phase_compression_roles and role not in self.phase_compression_roles:
                    compressed_middle.append(message)
                    continue
                if role == "assistant" and message.get("tool_calls"):
                    compressed_middle.append(message)
                    continue
                if role == "system":
                    compressed_middle.append(message)
                    continue
                if isinstance(content, str) and content.startswith("[compressed:"):
                    compressed_middle.append(message)
                    continue

                fingerprint = hashlib.sha256(f"{role}:{content}".encode("utf-8")).hexdigest()
                summary = self._summary_cache.get(fingerprint)
                if summary is None:
                    summary = self._summarize_text(content)
                    self._summary_cache[fingerprint] = summary
                if fingerprint not in self._seen and not self._archive_budget_exhausted():
                    self._seen.add(fingerprint)
                    self.archive.append(
                        {
                            "id": f"mem_{len(self.archive) + 1}",
                            "role": role,
                            "summary": summary,
                            "content": content,
                            "keywords": _keywords(content),
                        }
                    )
                    self.compression_stats["archived_count"] += 1

                cloned = dict(message)
                cloned["content"] = f"[compressed:{fingerprint[:8]}] {summary}"
                compressed_middle.append(cloned)

        recall_message = self._build_recall_message(suffix) if phase_active else None
        candidate_messages = prefix + ([recall_message] if recall_message else []) + compressed_middle + suffix

        candidate_tokens = sum(_estimate_tokens(_message_text(message)) for message in candidate_messages)
        decay_applied = False
        decayed_messages = 0
        if self.message_decay_enabled and candidate_tokens > self.decay_target_tokens and raw_tokens >= self.decay_warm_start_tokens:
            target_tokens = self.decay_target_tokens
            if candidate_tokens > self.decay_emergency_tokens:
                target_tokens = min(target_tokens, int(self.decay_target_tokens * 0.94))
            candidate_messages, decayed_messages = self._apply_decay(candidate_messages, target_tokens)
            decay_applied = decayed_messages > 0

        changed = _messages_changed(messages, candidate_messages)
        if changed:
            self.compression_stats["compress_invocations"] += 1

        self._record_compression_decision(
            raw_tokens=raw_tokens,
            threshold=threshold,
            phase_active=phase_active,
            recall_used=recall_message is not None,
            candidate_tokens=candidate_tokens,
            decay_applied=decay_applied,
            decayed_messages=decayed_messages,
            microcompacted_messages=microcompacted_messages,
            original_tokens=original_raw_tokens,
        )

        return candidate_messages, changed

    def _apply_tool_microcompact(self, messages):
        compacted = list(messages)
        protected_suffix_start = max(self.keep_prefix, len(compacted) - self.keep_suffix)
        tool_indices = [
            index
            for index, message in enumerate(compacted)
            if message.get("role") == "tool" and _message_text(message).strip()
        ]
        protected_tool_indices = set(tool_indices[-self.tool_microcompact_keep_recent_tool_messages :])
        microcompacted_messages = 0

        for index in tool_indices:
            if index < self.keep_prefix or index >= protected_suffix_start:
                continue
            if index in protected_tool_indices:
                continue
            original = _message_text(compacted[index])
            if _estimate_tokens(original) < self.tool_microcompact_min_message_tokens:
                continue
            if len(original) < self.tool_microcompact_min_message_chars:
                continue
            rewritten = _microcompact_tool_message_content(original, self.tool_microcompact_stub)
            if rewritten == original:
                continue
            message = dict(compacted[index])
            message["content"] = rewritten
            compacted[index] = message
            microcompacted_messages += 1

        self.compression_stats["microcompacted_count"] += microcompacted_messages
        return compacted, microcompacted_messages

    def _build_recall_message(self, suffix):
        if not self.archive:
            return None
        if self.max_retrieval_count and self.compression_stats["retrieval_count"] >= self.max_retrieval_count:
            return None

        latest = next(
            (
                _prepare_content_for_memory(message.get("role", ""), _message_text(message))
                for message in reversed(suffix)
                if message.get("role") != "tool" and _message_text(message).strip()
            ),
            "",
        )
        if not latest:
            latest = next((_prepare_content_for_memory(message.get("role", ""), _message_text(message)) for message in reversed(suffix) if _message_text(message).strip()), "")
        query_terms = set(_keywords(latest))
        if not query_terms:
            return None

        scored = []
        for item in self.archive:
            overlap = len(query_terms.intersection(item["keywords"]))
            if overlap >= 2:
                scored.append((overlap, item))

        if not scored:
            return None

        scored.sort(key=lambda pair: pair[0], reverse=True)
        recalled = [pair[1] for pair in scored[: self.retrieval_top_k]]
        self.compression_stats["retrieval_count"] += len(recalled)
        content = "Archived tool context recall:\n" + "\n".join(
            f"- {item['id']}: {item['summary']}" for item in recalled
        )
        return {"role": "assistant", "content": content}

    def _apply_decay(self, messages, target_tokens):
        decayed = list(messages)
        recent_budget = self.recent_raw_window_tokens
        protected = set()
        decayed_messages = 0

        for index in range(len(decayed) - 1, -1, -1):
            message = decayed[index]
            tokens = _estimate_tokens(_message_text(message))
            if message.get("role") in {"system", "user"}:
                protected.add(index)
                continue
            if recent_budget > 0:
                protected.add(index)
                recent_budget -= tokens
                continue

        while sum(_estimate_tokens(_message_text(message)) for message in decayed) > target_tokens:
            candidate_index = None
            candidate_tokens = 0
            for index, message in enumerate(decayed):
                if index in protected:
                    continue
                if message.get("role") in {"system", "user"}:
                    continue
                content = _message_text(message)
                role = message.get("role", "")
                if self.decay_candidate_roles and role not in self.decay_candidate_roles and not content.startswith("[compressed:"):
                    continue
                tokens = _estimate_tokens(_message_text(message))
                if tokens <= 24:
                    continue
                if tokens > candidate_tokens:
                    candidate_index = index
                    candidate_tokens = tokens
            if candidate_index is None:
                break
            message = dict(decayed[candidate_index])
            message["content"] = _shrink_text(_message_text(message), 0.55)
            decayed[candidate_index] = message
            decayed_messages += 1
        return decayed, decayed_messages

    def _record_compression_decision(
        self,
        *,
        raw_tokens,
        threshold,
        phase_active,
        recall_used,
        candidate_tokens,
        decay_applied,
        decayed_messages,
        microcompacted_messages,
        original_tokens,
    ):
        self.compression_decisions.append(
            {
                "originalTokens": original_tokens,
                "rawTokens": raw_tokens,
                "threshold": threshold,
                "phaseActive": phase_active,
                "recallUsed": recall_used,
                "candidateTokens": candidate_tokens,
                "decayApplied": decay_applied,
                "decayedMessages": decayed_messages,
                "microcompactedMessages": microcompacted_messages,
                "microcompactedCount": self.compression_stats["microcompacted_count"],
                "archivedCount": self.compression_stats["archived_count"],
                "retrievalCount": self.compression_stats["retrieval_count"],
                "summaryCallCount": self.compression_stats["summary_call_count"],
            }
        )
        if len(self.compression_decisions) > 120:
            self.compression_decisions = self.compression_decisions[-120:]

    def _summarize_text(self, text):
        fallback = _summarize_text(text)
        if not self.summary_model_name:
            return fallback
        if self.max_summary_calls and self.compression_stats["summary_call_count"] >= self.max_summary_calls:
            return fallback

        try:
            summary_result = _request_summary(self.summary_model_name, text, self.summary_model_kwargs)
            content = summary_result["content"]
            prompt_tokens = summary_result["inputTokens"]
            completion_tokens = summary_result["outputTokens"]
            total_tokens = summary_result["totalTokens"]
            self.summary_turns.append(
                {
                    "turnId": f"summary_{len(self.summary_turns) + 1}",
                    "phaseId": "compression",
                    "model": self.summary_model_name,
                    "kind": "summary",
                    "inputTokens": prompt_tokens,
                    "outputTokens": completion_tokens,
                    "totalTokens": total_tokens,
                }
            )
            self.compression_stats["summary_call_count"] += 1
            return (content or fallback).strip()
        except Exception:
            return fallback

    def _archive_budget_exhausted(self):
        return self.max_archive_records and self.compression_stats["archived_count"] >= self.max_archive_records

    def _guard_before_query(self, prepared_messages):
        if self.max_api_calls and self.compression_stats["compress_invocations"] > self.max_api_calls:
            raise RuntimeError(f"Compression guard: maxApiCalls exceeded ({self.max_api_calls}).")

        if self.max_retrieval_count and self.compression_stats["retrieval_count"] > self.max_retrieval_count:
            raise RuntimeError(f"Compression guard: maxRetrievalCount exceeded ({self.max_retrieval_count}).")

        prompt_fingerprint = hashlib.sha256(
            "\n".join(f"{message.get('role', '')}:{_message_text(message)}" for message in prepared_messages).encode("utf-8")
        ).hexdigest()
        self._prompt_fingerprints.append(prompt_fingerprint)
        if len(self._prompt_fingerprints) > 8:
            self._prompt_fingerprints = self._prompt_fingerprints[-8:]

        if self.max_repeated_prompt_fingerprints:
            repeated = 1
            for index in range(len(self._prompt_fingerprints) - 2, -1, -1):
                if self._prompt_fingerprints[index] != prompt_fingerprint:
                    break
                repeated += 1
            if repeated >= self.max_repeated_prompt_fingerprints:
                raise RuntimeError(
                    f"Compression guard: repeated prompt fingerprint seen {repeated} times consecutively."
                )

        trailing_format_errors = 0
        for message in reversed(prepared_messages):
            if message.get("role") != "user":
                break
            extra = message.get("extra", {}) or {}
            content = _message_text(message)
            if extra.get("interrupt_type") == "FormatError" and "No tool calls found" in content:
                trailing_format_errors += 1
                continue
            break
        if trailing_format_errors >= 3:
            raise RuntimeError(
                f"Compression guard: repeated tool-call format errors ({trailing_format_errors}) detected."
            )

    def _throttle_main_query(self, prepared_messages):
        if not self.main_tpm_limit:
            return

        now = time.time()
        self._tpm_window = [(timestamp, tokens) for timestamp, tokens in self._tpm_window if now - timestamp < 60]
        estimated_request_tokens = sum(_estimate_tokens(_message_text(message)) for message in prepared_messages)
        estimated_request_tokens += self.main_tpm_reserve_tokens
        used_tokens = sum(tokens for _, tokens in self._tpm_window)

        if used_tokens + estimated_request_tokens <= self.main_tpm_limit:
            self._tpm_window.append((now, estimated_request_tokens))
            return

        oldest_timestamp = self._tpm_window[0][0] if self._tpm_window else now
        sleep_seconds = max(0.0, 60 - (now - oldest_timestamp) + 0.25)
        if sleep_seconds > 0:
            time.sleep(sleep_seconds)
        now = time.time()
        self._tpm_window = [(timestamp, tokens) for timestamp, tokens in self._tpm_window if now - timestamp < 60]
        self._tpm_window.append((now, estimated_request_tokens))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--artifact-dir")
    args = parser.parse_args()

    payload = json.loads(Path(args.payload).read_text(encoding="utf-8"))
    task = payload["task"]
    variant = payload["variant"]
    config = yaml.safe_load((Path(package_dir) / "config" / "benchmarks" / "swebench.yaml").read_text(encoding="utf-8"))
    artifact_dir = Path(args.artifact_dir).resolve() if args.artifact_dir else None
    if artifact_dir:
        artifact_dir.mkdir(parents=True, exist_ok=True)

    trajectory_path = Path(tempfile.mkdtemp(prefix="mini-swe-agent-trajectory-")) / f"{task['instanceId']}.json"
    environment = build_environment(task, config.get("environment", {}))
    model = build_model(variant, config.get("model", {}))

    agent_kwargs = dict(config.get("agent", {}))
    agent_kwargs["output_path"] = trajectory_path
    agent = DefaultAgent(model, environment, **agent_kwargs)

    try:
        task_text = build_task_text(task)
        result = agent.run(task_text)
        serialized = agent.save(None)
        artifact_paths = persist_artifacts(artifact_dir, trajectory_path, serialized, model)
        patch, patch_debug = collect_patch(task, environment, result.get("submission") or "")
        usage = extract_usage(serialized.get("messages", []))
        summary_usage = extract_summary_usage(model)
        merged_usage = merge_usage(usage, summary_usage)
        model_stats = serialized.get("info", {}).get("model_stats", {})
        output = {
            "patch": patch,
            "usage": merged_usage["totals"],
            "turnUsages": merged_usage["turns"],
            "summary": serialized.get("info", {}).get("exit_status", ""),
            "metadata": {
                "compression_wrapper_enabled": bool(isinstance(model, CompressedLitellmModel)),
                "mini_swe_agent_cost": model_stats.get("instance_cost", 0.0),
                "mini_swe_agent_api_calls": model_stats.get("api_calls", 0),
                "submission_exit_status": serialized.get("info", {}).get("exit_status", ""),
                "patchDebug": patch_debug,
                **({"compression": getattr(model, "compression_stats", {})} if hasattr(model, "compression_stats") else {}),
            },
            "artifacts": artifact_paths,
        }
        Path(args.result).write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:
        serialized = safe_agent_save(agent)
        artifact_paths = persist_artifacts(artifact_dir, trajectory_path, serialized, model)
        error_payload = {
            "error": str(exc),
            "type": type(exc).__name__,
            "traceback": traceback.format_exc(),
        }
        if artifact_dir:
            Path(artifact_dir / "error.json").write_text(json.dumps(error_payload, indent=2) + "\n", encoding="utf-8")
        if args.result:
            preferred_patch = _extract_submission_candidate(serialized)
            patch, patch_debug = collect_patch(task, environment, preferred_patch)
            merged_usage = merge_usage(extract_usage(serialized.get("messages", [])), extract_summary_usage(model))
            model_stats = serialized.get("info", {}).get("model_stats", {})
            submitted = bool(patch.strip() and _has_submission_marker(serialized))
            metadata = {
                "compression_wrapper_enabled": bool(isinstance(model, CompressedLitellmModel)),
                "mini_swe_agent_cost": model_stats.get("instance_cost", 0.0),
                "mini_swe_agent_api_calls": model_stats.get("api_calls", 0),
                "patchDebug": patch_debug,
                **({"compression": getattr(model, "compression_stats", {})} if hasattr(model, "compression_stats") else {}),
            }
            summary_text = str(exc)
            if submitted:
                metadata["submission_exit_status"] = "Submitted"
                metadata["recovered_after_error"] = str(exc)
                summary_text = "Submitted"
            else:
                metadata["run_error"] = str(exc)
            failure_output = {
                "patch": patch,
                "usage": merged_usage["totals"],
                "turnUsages": merged_usage["turns"],
                "summary": summary_text,
                "metadata": metadata,
                "artifacts": artifact_paths,
            }
            Path(args.result).write_text(json.dumps(failure_output, indent=2) + "\n", encoding="utf-8")
        return
    finally:
        cleanup = getattr(environment, "cleanup", None)
        if callable(cleanup):
            cleanup()


def build_environment(task, env_config):
    env_kwargs = dict(env_config)
    if task.get("dockerImage"):
        env_kwargs["image"] = task["dockerImage"]
        if task.get("workingDirectory"):
            env_kwargs["cwd"] = task["workingDirectory"]
        return DockerEnvironment(**env_kwargs)

    if task.get("workspacePath"):
        env_kwargs["cwd"] = task["workspacePath"]
        if _should_use_wsl_local_shell(task):
            return WslLocalEnvironment(**env_kwargs)
        return LocalEnvironment(**env_kwargs)

    raise ValueError("Task requires dockerImage or workspacePath")


def build_model(variant, model_config):
    model_kwargs = dict(model_config)
    model_kwargs["model_name"] = _normalize_provider_model_name(variant["modelName"])
    merged_model_kwargs = dict(model_kwargs.get("model_kwargs", {}))
    merged_model_kwargs.setdefault("temperature", 0)
    if str(model_kwargs["model_name"]).startswith("openai/"):
        merged_model_kwargs.setdefault("custom_llm_provider", "openai")
    model_kwargs["model_kwargs"] = merged_model_kwargs
    compression_config = dict(variant.get("compression", {}) or {})
    should_wrap = bool(compression_config)

    if should_wrap:
        summary_model_name = variant.get("summarizerModel") or variant.get("compression", {}).get("summarizerModel")
        summary_model_kwargs = {
            "temperature": 0,
            "max_tokens": 60,
        }
        return CompressedLitellmModel(
            compression=compression_config,
            summary_model_name=summary_model_name,
            summary_model_kwargs=summary_model_kwargs,
            **model_kwargs,
        )
    return get_model(model_kwargs["model_name"], config=model_kwargs)


def build_task_text(task):
    parts = [task["problemStatement"]]
    hints = task.get("hints") or []
    if hints:
        parts.append("\nIssue discussion context (may be stale or superseded; prioritize reproduction and verification over these comments):")
        parts.extend(f"- {hint}" for hint in hints)
    parts.append(
        "\nEnvironment notes:\n"
        "- `rg` may be unavailable. Use `grep -RIn` as a fallback.\n"
        "- `pytest` may be unavailable as a shell command. Use `python -m pytest` or a direct reproduction script.\n"
        "- Do not hand-write `patch.txt` or emit `*** Begin Patch` blocks. Edit source files first, then generate `patch.txt` only with `git diff -- <modified source files>`."
    )
    verify_commands = task.get("verifyCommands") or []
    if verify_commands:
        parts.append(
            "\nTask-specific verification commands are the authoritative success criteria. Do not decide that 'no code changes are needed' unless you have first confirmed the unchanged code already passes these checks."
        )
        parts.append("Verification commands:")
        parts.extend(f"- {command}" for command in verify_commands)
    submission_command = "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && cat patch.txt"
    if task.get("workspacePath") and os.name == "nt" and not _should_use_wsl_local_shell(task):
        submission_command = "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && type patch.txt"
    parts.append(
        f"\nWhen the fix is ready, create patch.txt from the relevant source-file diffs, verify it, then submit with the exact command `{submission_command}`."
    )
    return "\n".join(parts)


def collect_patch(task, environment, preferred_patch=""):
    candidates = []
    diff_output = collect_workspace_diff(task, environment)
    if diff_output:
        candidates.append(("git-diff", diff_output))
    patch_file = collect_patch_file(task, environment)
    if patch_file:
        candidates.append(("patch.txt", patch_file))
    if preferred_patch:
        candidates.append(("submission", preferred_patch))

    debug = []
    validated = []
    for source, patch_text in candidates:
        sanitized = sanitize_patch_text(patch_text)
        validation = validate_patch(task, environment, sanitized)
        attempt = {
            "source": source,
            "rawLength": len(patch_text or ""),
            "sanitizedLength": len(sanitized or ""),
            "sanitizedPreview": sanitized[:400],
            **validation,
        }
        debug.append(attempt)
        if validation["valid"]:
            validated.append((source, sanitized))

    if validated:
        source_rank = {"patch.txt": 0, "submission": 1, "git-diff": 2}
        selected_source, selected_patch = min(
            validated,
            key=lambda item: _patch_candidate_sort_key(item[0], item[1], source_rank),
        )
        return selected_patch, {"attempts": debug, "selectedSource": selected_source}

    return "", {"attempts": debug, "selectedSource": None}


def _extract_submission_candidate(serialized):
    info = serialized.get("info", {}) or {}
    submission = info.get("submission")
    if isinstance(submission, str) and submission.strip():
        return submission
    for message in reversed(serialized.get("messages", [])):
        extra = message.get("extra", {}) or {}
        candidate = extra.get("submission")
        if isinstance(candidate, str) and candidate.strip():
            return candidate
        content = _message_text(message)
        if "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT" in content:
            return content
    return ""


def _has_submission_marker(serialized):
    for message in reversed(serialized.get("messages", [])):
        content = _message_text(message)
        if "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT" in content:
            return True
        extra = message.get("extra", {}) or {}
        submission = extra.get("submission")
        if isinstance(submission, str) and submission.strip():
            return True
    return False


def collect_workspace_diff(task, environment):
    cwd = task.get("workingDirectory") or task.get("workspacePath") or "/testbed"
    command = "git -c core.safecrlf=false diff --binary --ignore-cr-at-eol --no-ext-diff --no-textconv"
    if task.get("dockerImage") and getattr(environment, "container_id", None):
        result = subprocess.run(
            ["docker", "exec", "-w", cwd, environment.container_id, "bash", "-lc", command],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        return result.stdout

    if _should_use_wsl_local_shell(task):
        result = _run_wsl_git(task.get("workspacePath") or os.getcwd(), command)
        return result.stdout

    result = subprocess.run(
        command,
        shell=True,
        cwd=task.get("workspacePath") or os.getcwd(),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return result.stdout


def collect_patch_file(task, environment):
    cwd = task.get("workingDirectory") or task.get("workspacePath") or "/testbed"
    if task.get("dockerImage") and getattr(environment, "container_id", None):
        result = subprocess.run(
            ["docker", "exec", "-w", cwd, environment.container_id, "bash", "-lc", "test -f patch.txt && cat patch.txt || true"],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        return result.stdout

    patch_path = Path(task.get("workspacePath", "")) / "patch.txt"
    if patch_path.exists():
        return patch_path.read_text(encoding="utf-8", errors="replace")
    return ""


def sanitize_patch_text(text):
    if not text:
        return ""

    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    submit_marker = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"
    if submit_marker in normalized:
        suffix = normalized.rsplit(submit_marker, 1)[-1]
        if "diff --git " in suffix or "--- a/" in suffix:
            normalized = suffix
    if "*** Begin Patch" in normalized and "diff --git " not in normalized and "--- a/" not in normalized:
        converted = _convert_apply_patch_to_unified_diff(normalized)
        if converted:
            normalized = converted
    lines = normalized.splitlines()
    start_index = None
    for index, line in enumerate(lines):
        if line.startswith("diff --git ") or line.startswith("--- a/"):
            start_index = index
            break
    if start_index is None:
        return ""

    relevant = lines[start_index:]
    if not relevant:
        return ""

    if relevant[0].startswith("diff --git "):
        sections = []
        current = []
        for line in relevant:
            if line.startswith("diff --git "):
                if current:
                    sections.append(current)
                current = [line]
                continue
            if current:
                current.append(line)
        if current:
            sections.append(current)
        kept = [section for section in sections if _should_keep_patch_section(section)]
        normalized = ("\n".join("\n".join(section).rstrip("\n") for section in kept).strip() + "\n") if kept else ""
        return _repair_unified_diff(normalized)

    if _should_keep_patch_section(relevant):
        return _repair_unified_diff("\n".join(relevant).strip() + "\n")
    return ""


def _repair_unified_diff(patch_text):
    if not patch_text.strip():
        return ""

    lines = patch_text.splitlines()
    repaired = []
    index = 0
    while index < len(lines):
        line = lines[index]
        repaired.append(line)
        if not line.startswith("@@ "):
            index += 1
            continue

        match = re.match(r"^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@", line)
        if not match:
            index += 1
            continue

        old_expected = int(match.group(1) or "1")
        new_expected = int(match.group(2) or "1")
        old_seen = 0
        new_seen = 0
        index += 1
        while index < len(lines):
            hunk_line = lines[index]
            if hunk_line.startswith(("diff --git ", "@@ ", "--- a/", "+++ b/")):
                break
            repaired.append(hunk_line)
            if hunk_line.startswith(" "):
                old_seen += 1
                new_seen += 1
            elif hunk_line.startswith("-"):
                old_seen += 1
            elif hunk_line.startswith("+"):
                new_seen += 1
            elif hunk_line == r"\ No newline at end of file":
                pass
            else:
                break
            index += 1

        while old_seen < old_expected and new_seen < new_expected:
            repaired.append(" ")
            old_seen += 1
            new_seen += 1
        continue

    return "\n".join(repaired).rstrip("\n") + "\n"


def _convert_apply_patch_to_unified_diff(text):
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if "*** Begin Patch" not in normalized:
        return ""
    lines = normalized.splitlines()
    if not lines or lines[0].strip() != "*** Begin Patch":
        return ""

    patch_lines = []
    index = 1
    while index < len(lines):
        line = lines[index]
        if line.startswith("*** End Patch"):
            break
        if not line.startswith("*** Update File: "):
            index += 1
            continue
        path_value = line.split(": ", 1)[1].strip()
        index += 1
        file_lines = []
        while index < len(lines):
            current = lines[index]
            if current.startswith("*** Update File: ") or current.startswith("*** End Patch"):
                break
            file_lines.append(current)
            index += 1
        if not file_lines:
            continue
        patch_lines.append(f"diff --git a/{path_value} b/{path_value}")
        patch_lines.append(f"--- a/{path_value}")
        patch_lines.append(f"+++ b/{path_value}")
        patch_lines.extend(file_lines)

    if not patch_lines:
        return ""
    return _repair_unified_diff("\n".join(patch_lines).rstrip("\n") + "\n")


def validate_patch(task, environment, patch_text):
    if not patch_text.strip():
        return {"valid": False, "validationCommand": "", "validationOutput": "empty patch"}

    workspace = task.get("workspacePath")
    if not workspace:
        return {"valid": True, "validationCommand": "", "validationOutput": "validation skipped for non-local workspace"}

    if _should_use_wsl_local_shell(task):
        looks_like_patch = (
            ("diff --git " in patch_text or patch_text.lstrip().startswith("--- a/"))
            and "@@" in patch_text
            and ("\n+" in patch_text or "\n-" in patch_text)
        )
        return {
            "valid": looks_like_patch,
            "validationCommand": "structural patch check",
            "validationOutput": "accepted by structural patch check for WSL-local worktree"
            if looks_like_patch
            else "missing diff headers or hunks",
            "validationMode": "structural",
        }

    patch_file = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".patch") as handle:
            handle.write(patch_text)
            patch_file = handle.name
        if _should_use_wsl_local_shell(task):
            result = _run_wsl_git(
                workspace,
                f"git apply --check --whitespace=nowarn {shlex.quote(_windows_to_wsl_path(patch_file))}",
            )
        else:
            result = subprocess.run(
                ["git", "-C", workspace, "apply", "--check", "--whitespace=nowarn", patch_file],
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        output = (result.stdout or "") + (result.stderr or "")
        if result.returncode == 0:
            return {
                "valid": True,
                "validationCommand": f"git -C {workspace} apply --check --whitespace=nowarn <temp.patch>",
                "validationOutput": output.strip(),
            }

        if _should_use_wsl_local_shell(task):
            reverse = _run_wsl_git(
                workspace,
                f"git apply --check --reverse --whitespace=nowarn {shlex.quote(_windows_to_wsl_path(patch_file))}",
            )
        else:
            reverse = subprocess.run(
                ["git", "-C", workspace, "apply", "--check", "--reverse", "--whitespace=nowarn", patch_file],
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        reverse_output = (reverse.stdout or "") + (reverse.stderr or "")
        return {
            "valid": reverse.returncode == 0,
            "validationCommand": (
                f"git -C {workspace} apply --check --whitespace=nowarn <temp.patch> || "
                f"git -C {workspace} apply --check --reverse --whitespace=nowarn <temp.patch>"
            ),
            "validationOutput": (output if output.strip() else reverse_output).strip(),
            "validationMode": "reverse" if reverse.returncode == 0 else "forward",
        }
    finally:
        if patch_file:
            try:
                os.unlink(patch_file)
            except OSError:
                pass


def _should_keep_patch_section(lines):
    patch_path = _patch_section_path(lines)
    return bool(patch_path and not _is_excluded_patch_path(patch_path))


def _patch_section_path(lines):
    for line in lines:
        if line.startswith("diff --git "):
            match = re.match(r"^diff --git a/(.+?) b/(.+)$", line)
            if match:
                return match.group(2)
        if line.startswith("+++ b/"):
            return line[6:]
        if line.startswith("--- a/"):
            return line[6:]
    return ""


def _is_excluded_patch_path(path_value):
    normalized = path_value.replace("\\", "/").lstrip("./")
    excluded_prefixes = (
        "tests/",
        "test/",
        ".circleci/",
        ".github/",
        "docs/",
        "examples/",
        "build_tools/",
        "source/",
    )
    excluded_names = {
        "patch.txt",
        "pyproject.toml",
        "setup.cfg",
        "setup.py",
        "tox.ini",
        "noxfile.py",
    }
    return normalized.startswith(excluded_prefixes) or Path(normalized).name in excluded_names


def _patch_candidate_sort_key(source, patch_text, source_rank):
    file_count = len(re.findall(r"^diff --git a/(.+?) b/(.+)$", patch_text, flags=re.MULTILINE))
    changed_lines = 0
    for line in patch_text.splitlines():
        if line.startswith(("+++", "---", "@@")):
            continue
        if line.startswith(("+", "-")):
            changed_lines += 1
    suspicious = (
        file_count > 25
        or len(patch_text) > 250000
        or changed_lines > 4000
    )
    return (
        1 if suspicious else 0,
        source_rank.get(source, 99),
        file_count,
        changed_lines,
        len(patch_text),
    )


def extract_usage(messages):
    turns = []
    totals = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    for index, message in enumerate(messages):
        extra = message.get("extra", {})
        response = extra.get("response") or {}
        usage = response.get("usage") or {}
        input_tokens = _first_int(usage, "prompt_tokens", "input_tokens", "promptTokens", "inputTokens")
        output_tokens = _first_int(usage, "completion_tokens", "output_tokens", "completionTokens", "outputTokens")
        total_tokens = _first_int(usage, "total_tokens", "totalTokens")
        if total_tokens == 0:
            total_tokens = input_tokens + output_tokens
        if input_tokens == 0 and output_tokens == 0 and total_tokens == 0:
            continue
        turn = {
            "turnId": response.get("id", f"turn_{index}"),
            "phaseId": f"call_{len(turns) + 1}",
            "model": response.get("model", response.get("model_name", "")),
            "kind": "response",
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total_tokens,
        }
        turns.append(turn)
        totals["inputTokens"] += input_tokens
        totals["outputTokens"] += output_tokens
        totals["totalTokens"] += total_tokens
    return {"turns": turns, "totals": totals}


def extract_summary_usage(model):
    turns = list(getattr(model, "summary_turns", []))
    totals = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    for turn in turns:
        totals["inputTokens"] += int(turn.get("inputTokens", 0))
        totals["outputTokens"] += int(turn.get("outputTokens", 0))
        totals["totalTokens"] += int(turn.get("totalTokens", 0))
    return {"turns": turns, "totals": totals}


def merge_usage(primary, secondary):
    return {
        "turns": [*primary.get("turns", []), *secondary.get("turns", [])],
        "totals": {
            "inputTokens": int(primary["totals"].get("inputTokens", 0)) + int(secondary["totals"].get("inputTokens", 0)),
            "outputTokens": int(primary["totals"].get("outputTokens", 0)) + int(secondary["totals"].get("outputTokens", 0)),
            "totalTokens": int(primary["totals"].get("totalTokens", 0)) + int(secondary["totals"].get("totalTokens", 0)),
        },
    }


def _first_int(mapping, *keys):
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
    return 0


def _get_usage_value(usage, *keys):
    if usage is None:
        return 0
    if hasattr(usage, "model_dump"):
        usage = usage.model_dump()
    if hasattr(usage, "dict"):
        usage = usage.dict()
    if isinstance(usage, dict):
        return _first_int(usage, *keys)
    for key in keys:
        value = getattr(usage, key, None)
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
    return 0


def _message_text(message):
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text", item.get("content", ""))))
            else:
                parts.append(str(item))
        return " ".join(parts)
    return str(content)


def _estimate_tokens(text):
    return max(1, len(text) // 4) if text else 0


def _summarize_text(text):
    cleaned = " ".join(text.strip().split())
    if len(cleaned) <= 96:
        return cleaned
    return f"{cleaned[:60].rstrip()} ... {cleaned[-28:].lstrip()}"


def _shrink_text(text, ratio):
    cleaned = " ".join(text.strip().split())
    target = max(32, int(len(cleaned) * ratio))
    if len(cleaned) <= target:
        return cleaned
    head = max(16, int(target * 0.65))
    tail = max(10, target - head - 5)
    return f"{cleaned[:head].rstrip()} ... {cleaned[-tail:].lstrip()}"


def _keywords(text):
    stop_tokens = {
        "returncode",
        "output",
        "traceback",
        "line",
        "file",
        "command",
        "bash",
        "python",
        "error",
        "warning",
    }
    return [
        token
        for token in re.split(r"[^a-zA-Z0-9_./-]+", text.lower())
        if len(token) >= 4 and token not in stop_tokens
    ][:24]


def _normalize_provider_model_name(model_name):
    if not model_name or "/" in model_name:
        return model_name
    if re.match(r"^(gpt|o[1-9]|text-embedding)", model_name):
        return f"openai/{model_name}"
    return model_name


def _split_provider_model_name(model_name):
    normalized = _normalize_provider_model_name(model_name)
    if normalized and normalized.startswith("openai/"):
        return normalized.split("/", 1)[1], {"custom_llm_provider": "openai"}
    return normalized, {}


class WslLocalEnvironment(LocalEnvironment):
    def execute(self, action: dict, cwd: str = "", *, timeout: int | None = None) -> dict:
        command = action.get("command", "")
        cwd = cwd or self.config.cwd or os.getcwd()
        wsl_cwd = _windows_to_wsl_path(cwd)
        wsl_git_dir = _read_wsl_gitdir(cwd)
        command = _rewrite_testbed_paths(command, "/tmp/mswea-testbed")
        export_prefix = "".join(
            f"export {key}={shlex.quote(str(value))}; " for key, value in (self.config.env or {}).items()
        )
        if wsl_git_dir:
            export_prefix += (
                f"export GIT_DIR={shlex.quote(wsl_git_dir)}; "
                "export GIT_WORK_TREE=/tmp/mswea-testbed; "
            )
        shell_prelude = (
            "set +e; "
            "mkdir -p /tmp; "
            f"ln -sfn {shlex.quote(wsl_cwd)} /tmp/mswea-testbed; "
            "if ! command -v python >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then "
            "python() { python3 \"$@\"; }; "
            "fi; "
            "if ! command -v rg >/dev/null 2>&1; then "
            "rg() { if [ \"$1\" = \"--files\" ]; then find . -type f | sed 's#^./##'; else grep -RIn \"$@\"; fi; }; "
            "fi; "
            "if ! command -v pytest >/dev/null 2>&1; then "
            "pytest() { python -m pytest \"$@\"; }; "
            "fi; "
        )
        wrapped = f"{shell_prelude}{export_prefix}cd /tmp/mswea-testbed && {command}"
        try:
            result = subprocess.run(
                ["wsl.exe", "bash", "-lc", wrapped],
                text=True,
                cwd=os.getcwd(),
                env=os.environ,
                timeout=timeout or self.config.timeout,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
            output = {"output": result.stdout, "returncode": result.returncode, "exception_info": ""}
        except Exception as e:
            raw_output = getattr(e, "output", None)
            raw_output = (
                raw_output.decode("utf-8", errors="replace") if isinstance(raw_output, bytes) else (raw_output or "")
            )
            output = {
                "output": raw_output,
                "returncode": -1,
                "exception_info": f"An error occurred while executing the command: {e}",
                "extra": {"exception_type": type(e).__name__, "exception": str(e)},
            }
        self._check_finished(output)
        return output

    def serialize(self) -> dict:
        base = super().serialize()
        base["info"]["config"]["environment"]["shell"] = "wsl-bash"
        return base


def _should_use_wsl_local_shell(task):
    return bool(os.name == "nt" and task.get("workspacePath") and shutil.which("wsl.exe"))


def _windows_to_wsl_path(path_value):
    if not path_value:
        return path_value
    normalized = str(path_value).replace("\\", "/")
    match = re.match(r"^([A-Za-z]):/(.*)$", normalized)
    if not match:
        return normalized
    drive = match.group(1).lower()
    remainder = match.group(2)
    return f"/mnt/{drive}/{remainder}"


def _rewrite_testbed_paths(command, replacement):
    if not command or "/testbed" not in command:
        return command
    return command.replace("/testbed", replacement)


def _run_wsl_git(workspace_path, command):
    wsl_workspace = _windows_to_wsl_path(workspace_path)
    wsl_git_dir = _read_wsl_gitdir(workspace_path)
    export_prefix = ""
    if wsl_git_dir:
        export_prefix = (
            f"export GIT_DIR={shlex.quote(wsl_git_dir)}; "
            f"export GIT_WORK_TREE={shlex.quote(wsl_workspace)}; "
        )
    return subprocess.run(
        ["wsl.exe", "bash", "-lc", f"{export_prefix}cd {shlex.quote(wsl_workspace)} && {command}"],
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def _read_wsl_gitdir(workspace_path):
    if not workspace_path or os.name != "nt":
        return None
    git_file = Path(workspace_path) / ".git"
    try:
        original = git_file.read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"^gitdir:\s+(.+)$", original, flags=re.MULTILINE)
    if not match:
        return None
    raw_path = match.group(1).strip()
    if not re.match(r"^[A-Za-z]:[\\/]", raw_path) and not re.match(r"^[A-Za-z]:/", raw_path):
        return None
    return _windows_to_wsl_path(raw_path)


def _prepare_content_for_memory(role, text):
    cleaned = text.replace("\x00", "")
    if role != "tool":
        return cleaned

    returncode_match = re.search(r"<returncode>(-?\d+)</returncode>", cleaned)
    output_match = re.search(r"<output>\n?(.*?)</output>", cleaned, flags=re.DOTALL)
    exception_match = re.search(r"<exception>(.*?)</exception>", cleaned, flags=re.DOTALL)
    extracted = []
    if returncode_match:
        extracted.append(f"returncode={returncode_match.group(1)}")
    if exception_match and exception_match.group(1).strip():
        extracted.append(exception_match.group(1).strip())
    if output_match and output_match.group(1).strip():
        extracted.append(output_match.group(1).strip())
    cleaned = "\n".join(extracted).strip() or cleaned

    lines = cleaned.splitlines()
    filtered = []
    omitted = 0
    for line in lines:
        if not line:
            filtered.append(line)
            continue
        weird_chars = sum(1 for char in line if char == "\ufffd" or (ord(char) < 32 and char not in "\t\r\n"))
        if weird_chars > max(4, len(line) // 8):
            omitted += 1
            continue
        filtered.append(line[:600])
    if omitted:
        filtered.append(f"[omitted {omitted} binary/non-text lines]")
    cleaned = "\n".join(filtered)
    if len(cleaned) > 12000:
        cleaned = f"{cleaned[:7000].rstrip()}\n...[truncated tool output]...\n{cleaned[-1800:].lstrip()}"
    return cleaned


def _microcompact_tool_message_content(text, stub):
    cleaned = text.replace("\r\n", "\n").replace("\r", "\n")
    if not cleaned.strip() or stub in cleaned:
        return cleaned

    returncode_match = re.search(r"<returncode>(-?\d+)</returncode>", cleaned)
    exception_match = re.search(r"<exception>(.*?)</exception>", cleaned, flags=re.DOTALL)
    warning_match = re.search(r"<warning>(.*?)</warning>", cleaned, flags=re.DOTALL)

    parts = []
    if returncode_match:
        parts.append(f"<returncode>{returncode_match.group(1)}</returncode>")

    if exception_match and exception_match.group(1).strip():
        parts.append(f"<exception>{stub}</exception>")
    elif warning_match and warning_match.group(1).strip():
        parts.append(f"<warning>{stub}</warning>")
    else:
        parts.append(f"<output>\n{stub}\n</output>")

    return "\n".join(parts)


def _messages_changed(original_messages, prepared_messages):
    if len(original_messages) != len(prepared_messages):
        return True

    for original, prepared in zip(original_messages, prepared_messages):
        if original.get("role") != prepared.get("role"):
            return True
        if original.get("content") != prepared.get("content"):
            return True
        if bool(original.get("tool_calls")) != bool(prepared.get("tool_calls")):
            return True

    return False


def _request_summary(summary_model_name, text, summary_model_kwargs):
    normalized = _normalize_provider_model_name(summary_model_name)
    messages = [
        {
            "role": "system",
            "content": "Compress agent transcript text into one factual line under 28 tokens. Keep files, tools, commands, and errors only if they matter later.",
        },
        {"role": "user", "content": text},
    ]

    if normalized and normalized.startswith("openai/") and OpenAI is not None:
        client = OpenAI()
        response = client.chat.completions.create(
            model=normalized.split("/", 1)[1],
            messages=messages,
            temperature=summary_model_kwargs.get("temperature", 0),
            max_tokens=summary_model_kwargs.get("max_tokens", 60),
        )
        usage = getattr(response, "usage", None)
        prompt_tokens = _get_usage_value(usage, "prompt_tokens", "input_tokens", "promptTokens", "inputTokens")
        completion_tokens = _get_usage_value(
            usage, "completion_tokens", "output_tokens", "completionTokens", "outputTokens"
        )
        total_tokens = _get_usage_value(usage, "total_tokens", "totalTokens") or (prompt_tokens + completion_tokens)
        return {
            "content": response.choices[0].message.content or "",
            "inputTokens": prompt_tokens,
            "outputTokens": completion_tokens,
            "totalTokens": total_tokens,
        }

    model_name, provider_kwargs = _split_provider_model_name(summary_model_name)
    response = litellm.completion(
        model=model_name,
        messages=messages,
        **provider_kwargs,
        **summary_model_kwargs,
    )
    usage = getattr(response, "usage", None)
    prompt_tokens = _get_usage_value(usage, "prompt_tokens", "input_tokens", "promptTokens", "inputTokens")
    completion_tokens = _get_usage_value(
        usage, "completion_tokens", "output_tokens", "completionTokens", "outputTokens"
    )
    total_tokens = _get_usage_value(usage, "total_tokens", "totalTokens") or (prompt_tokens + completion_tokens)
    return {
        "content": response.choices[0].message.content or "",
        "inputTokens": prompt_tokens,
        "outputTokens": completion_tokens,
        "totalTokens": total_tokens,
    }


def safe_agent_save(agent):
    try:
        serialized = agent.save(None)
        if isinstance(serialized, dict):
            return serialized
    except Exception:
        pass
    return {"messages": [], "info": {}}


def persist_artifacts(artifact_dir, trajectory_path, serialized, model):
    if not artifact_dir:
        return {}

    artifact_dir.mkdir(parents=True, exist_ok=True)
    persisted = {}
    if trajectory_path.exists():
        destination = artifact_dir / "trajectory.json"
        shutil.copyfile(trajectory_path, destination)
        persisted["trajectoryPath"] = str(destination)

    serialized_path = artifact_dir / "serialized.json"
    serialized_path.write_text(json.dumps(serialized, indent=2) + "\n", encoding="utf-8")
    persisted["serializedPath"] = str(serialized_path)

    compression_path = artifact_dir / "compression-debug.json"
    compression_path.write_text(
        json.dumps(
            {
                "archive": getattr(model, "archive", []),
                "summaryTurns": getattr(model, "summary_turns", []),
                "compressionStats": getattr(model, "compression_stats", {}),
                "decisions": getattr(model, "compression_decisions", []),
                "summaryModel": getattr(model, "summary_model_name", None),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    persisted["compressionDebugPath"] = str(compression_path)
    return persisted


if __name__ == "__main__":
    main()
