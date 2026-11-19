// Both runtime clients implement abort() to cancel their active request.
import './gemini-llm.js';
import './minimax-llm.js';

declare module './gemini-llm.js' {
  interface GeminiLlmClient {
    abort(): void;
  }
}

declare module './minimax-llm.js' {
  interface MinimaxLlmClient {
    abort(): void;
  }
}
