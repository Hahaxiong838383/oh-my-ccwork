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
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return resp.choices[0].message.content or ""


def chat_stream(client, model, messages, max_tokens=500, temperature=0.0):
    """Returns (full_text, ttft_ms, total_ms, completion_tokens)."""
    chunks = []
    ttft = None
    t0 = time.perf_counter()

    stream = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.7,
        stream=True,
    )
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            if ttft is None:
                ttft = (time.perf_counter() - t0) * 1000
            chunks.append(chunk.choices[0].delta.content)

    total = (time.perf_counter() - t0) * 1000
    text = "".join(chunks)
    # rough token count: 1 token ≈ 1.5 chars for Chinese
    est_tokens = max(len(text) // 2, 1)
    return text, ttft or total, total, est_tokens


def print_header(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print(f"{'='*60}\n")
