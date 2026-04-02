import yaml
import time
from pathlib import Path
from openai import OpenAI


def load_config():
    config_path = Path(__file__).parent / "config.yaml"
    with open(config_path) as f:
        return yaml.safe_load(f)


def get_client(config=None):
    if config is None:
        config = load_config()
    return OpenAI(
        base_url=config["api"]["base_url"],
        api_key=config["api"]["api_key"],
    )


def chat(client, model, messages, max_tokens=500, temperature=0.0):
    # Disable thinking mode to get full content in response
    # Qwen3.5 thinking mode puts answer in reasoning field, content is truncated
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
    )
    msg = resp.choices[0].message
    content = msg.content or ""
    # If content is empty but reasoning exists, use reasoning
    reasoning = getattr(msg, "reasoning", None) or getattr(msg, "reasoning_content", None) or ""
    if not content.strip() and reasoning:
        content = reasoning
    return content


def chat_timed(client, model, messages, max_tokens=500):
    """Non-stream timed call. Returns (text, total_ms, completion_tokens)."""
    t0 = time.perf_counter()
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.7,
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
    )
    total = (time.perf_counter() - t0) * 1000
    msg = resp.choices[0].message
    text = msg.content or ""
    usage = resp.usage
    comp_tokens = usage.completion_tokens if usage else max(len(text) // 2, 1)
    return text, total, comp_tokens


def print_header(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}\n")
