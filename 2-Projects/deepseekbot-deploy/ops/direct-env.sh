# Sourced by DeepSeekBot service launchers. Never inherit an outbound proxy.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
unset GLOBAL_AGENT_HTTP_PROXY GLOBAL_AGENT_HTTPS_PROXY npm_config_proxy npm_config_https_proxy
export NO_PROXY='*'
export no_proxy='*'
export NODE_USE_ENV_PROXY=0
