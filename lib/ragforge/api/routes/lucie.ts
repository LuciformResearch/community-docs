/**
 * Lucie Agent Conversation Routes
 *
 * Handles conversation management with L1 summaries for the Lucie persona agent.
 * Supports visitor-based conversations (no auth required).
 */

import type { FastifyInstance } from "fastify";
import type { Neo4jClient } from "../../neo4j-client";
import { int as neo4jInt } from "neo4j-driver";
import Anthropic from "@anthropic-ai/sdk";

// ============================================================================
// Types
// ============================================================================

interface LucieMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface LucieSummary {
  id: string;
  level: number;
  content: string;
  turnStart: number;
  turnEnd: number;
  createdAt: string;
}

interface ConversationContext {
  conversationId: string;
  summaries: LucieSummary[];
  recentMessages: LucieMessage[];
  totalMessages: number;
}

// ============================================================================
// Configuration
// ============================================================================

const SUMMARIZE_AFTER_MESSAGES = 10; // Create L1 summary after this many messages
const RECENT_MESSAGES_COUNT = 5; // Keep this many recent messages in context
const L1_SUMMARY_MODEL = "claude-sonnet-4-20250514";

// ============================================================================
// LucieConversationService
// ============================================================================

class LucieConversationService {
  private neo4j: Neo4jClient;
  private anthropic: Anthropic | null = null;

  constructor(neo4j: Neo4jClient) {
    this.neo4j = neo4j;

    // Initialize Anthropic client if API key available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }
  }

  /**
   * Get or create a conversation for a visitor
   */
  async getOrCreateConversation(visitorId: string): Promise<string> {
    const conversationId = `lucie-${visitorId}`;

    // Check if conversation exists
    const existsResult = await this.neo4j.run(
      `MATCH (c:LucieConversation {id: $id}) RETURN c.id AS id`,
      { id: conversationId }
    );

    if (existsResult.records.length === 0) {
      // Create new conversation
      await this.neo4j.run(
        `CREATE (c:LucieConversation {
          id: $id,
          visitorId: $visitorId,
          createdAt: datetime(),
          updatedAt: datetime(),
          messageCount: 0,
          lastSummarizedTurn: 0
        })`,
        { id: conversationId, visitorId }
      );
      console.log(`[Lucie] Created conversation: ${conversationId}`);
    }

    return conversationId;
  }

  /**
   * Add a message to the conversation
   */
  async addMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: string
  ): Promise<{ messageId: string; shouldSummarize: boolean }> {
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Get current message count
    const countResult = await this.neo4j.run(
      `MATCH (c:LucieConversation {id: $conversationId})
       RETURN c.messageCount AS count, c.lastSummarizedTurn AS lastSummarized`,
      { conversationId }
    );

    const currentCount = this.extractInt(countResult.records[0]?.get("count")) || 0;
    const lastSummarized = this.extractInt(countResult.records[0]?.get("lastSummarized")) || 0;
    const turnIndex = currentCount + 1;

    // Add message
    await this.neo4j.run(
      `MATCH (c:LucieConversation {id: $conversationId})
       CREATE (m:LucieMessage {
         id: $messageId,
         conversationId: $conversationId,
         role: $role,
         content: $content,
         turnIndex: $turnIndex,
         timestamp: datetime()
       })
       CREATE (c)-[:HAS_MESSAGE]->(m)
       SET c.messageCount = $turnIndex, c.updatedAt = datetime()`,
      { conversationId, messageId, role, content, turnIndex: neo4jInt(turnIndex) }
    );

    // Check if we should create a summary
    const unsummarizedCount = turnIndex - lastSummarized;
    const shouldSummarize = unsummarizedCount >= SUMMARIZE_AFTER_MESSAGES;

    return { messageId, shouldSummarize };
  }

  /**
   * Get conversation context (summaries + recent messages)
   */
  async getContext(conversationId: string): Promise<ConversationContext> {
    // Get summaries
    const summariesResult = await this.neo4j.run(
      `MATCH (c:LucieConversation {id: $conversationId})-[:HAS_SUMMARY]->(s:LucieSummary)
       RETURN s.id AS id, s.level AS level, s.content AS content,
              s.turnStart AS turnStart, s.turnEnd AS turnEnd, s.createdAt AS createdAt
       ORDER BY s.level ASC, s.turnStart ASC`,
      { conversationId }
    );

    const summaries: LucieSummary[] = summariesResult.records.map((r) => ({
      id: r.get("id"),
      level: this.extractInt(r.get("level")) || 1,
      content: r.get("content"),
      turnStart: this.extractInt(r.get("turnStart")) || 0,
      turnEnd: this.extractInt(r.get("turnEnd")) || 0,
      createdAt: r.get("createdAt")?.toString() || "",
    }));

    // Get recent messages (after last summary or last N messages)
    const lastSummaryTurn = summaries.length > 0
      ? Math.max(...summaries.map((s) => s.turnEnd))
      : 0;

    const messagesResult = await this.neo4j.run(
      `MATCH (c:LucieConversation {id: $conversationId})-[:HAS_MESSAGE]->(m:LucieMessage)
       WHERE m.turnIndex > $lastSummaryTurn OR m.turnIndex > (c.messageCount - $recentCount)
       RETURN m.id AS id, m.role AS role, m.content AS content, m.timestamp AS timestamp
       ORDER BY m.turnIndex ASC
       LIMIT toInteger($limit)`,
      {
        conversationId,
        lastSummaryTurn: neo4jInt(lastSummaryTurn),
        recentCount: neo4jInt(RECENT_MESSAGES_COUNT),
        limit: neo4jInt(RECENT_MESSAGES_COUNT * 2),
      }
    );

    const recentMessages: LucieMessage[] = messagesResult.records.map((r) => ({
      id: r.get("id"),
      role: r.get("role"),
      content: r.get("content"),
      timestamp: r.get("timestamp")?.toString() || "",
    }));

    // Get total message count
    const countResult = await this.neo4j.run(
      `MATCH (c:LucieConversation {id: $conversationId})
       RETURN c.messageCount AS count`,
      { conversationId }
    );
    const totalMessages = this.extractInt(countResult.records[0]?.get("count")) || 0;

    return {
      conversationId,
      summaries,
      recentMessages,
      totalMessages,
    };
  }

  /**
   * Create L1 summary for unsummarized messages
   */
  async createL1Summary(conversationId: string): Promise<LucieSummary | null> {
    if (!this.anthropic) {
      console.warn("[Lucie] Cannot create summary: Anthropic API key not configured");
      return null;
    }

    // Get conversation state
    const stateResult = await this.neo4j.run(
      `MATCH (c:LucieConversation {id: $conversationId})
       RETURN c.lastSummarizedTurn AS lastSummarized, c.messageCount AS total`,
      { conversationId }
    );

    const lastSummarized = this.extractInt(stateResult.records[0]?.get("lastSummarized")) || 0;
    const totalMessages = this.extractInt(stateResult.records[0]?.get("total")) || 0;

    if (totalMessages - lastSummarized < SUMMARIZE_AFTER_MESSAGES) {
      return null; // Not enough messages to summarize
    }

    // Get messages to summarize
    const messagesResult = await this.neo4j.run(
      `MATCH (c:LucieConversation {id: $conversationId})-[:HAS_MESSAGE]->(m:LucieMessage)
       WHERE m.turnIndex > $lastSummarized AND m.turnIndex <= $endTurn
       RETURN m.role AS role, m.content AS content, m.turnIndex AS turnIndex
       ORDER BY m.turnIndex ASC`,
      {
        conversationId,
        lastSummarized: neo4jInt(lastSummarized),
        endTurn: neo4jInt(lastSummarized + SUMMARIZE_AFTER_MESSAGES),
      }
    );

    if (messagesResult.records.length === 0) {
      return null;
    }

    // Format messages for summarization
    const messagesToSummarize = messagesResult.records.map((r) => ({
      role: r.get("role") as "user" | "assistant",
      content: r.get("content"),
    }));

    const turnStart = lastSummarized + 1;
    const turnEnd = lastSummarized + messagesToSummarize.length;

    // Generate summary using Claude
    const summaryPrompt = this.buildSummaryPrompt(messagesToSummarize);

    try {
      const response = await this.anthropic.messages.create({
        model: L1_SUMMARY_MODEL,
        max_tokens: 500,
        messages: [{ role: "user", content: summaryPrompt }],
      });

      const summaryContent = response.content[0].type === "text"
        ? response.content[0].text
        : "";

      // Store summary
      const summaryId = `summary-${Date.now()}`;
      await this.neo4j.run(
        `MATCH (c:LucieConversation {id: $conversationId})
         CREATE (s:LucieSummary {
           id: $summaryId,
           conversationId: $conversationId,
           level: 1,
           content: $content,
           turnStart: $turnStart,
           turnEnd: $turnEnd,
           createdAt: datetime()
         })
         CREATE (c)-[:HAS_SUMMARY]->(s)
         SET c.lastSummarizedTurn = $turnEnd`,
        {
          conversationId,
          summaryId,
          content: summaryContent,
          turnStart: neo4jInt(turnStart),
          turnEnd: neo4jInt(turnEnd),
        }
      );

      console.log(`[Lucie] Created L1 summary for turns ${turnStart}-${turnEnd}`);

      return {
        id: summaryId,
        level: 1,
        content: summaryContent,
        turnStart,
        turnEnd,
        createdAt: new Date().toISOString(),
      };
    } catch (error: any) {
      console.error(`[Lucie] Failed to create summary: ${error.message}`);
      return null;
    }
  }

  /**
   * Build the context string for the agent
   */
  buildContextString(context: ConversationContext): string {
    const parts: string[] = [];

    // Add summaries
    if (context.summaries.length > 0) {
      parts.push("## Previous Conversation Summary\n");
      for (const summary of context.summaries) {
        parts.push(`[Turns ${summary.turnStart}-${summary.turnEnd}]: ${summary.content}\n`);
      }
    }

    // Add recent messages
    if (context.recentMessages.length > 0) {
      parts.push("\n## Recent Messages\n");
      for (const msg of context.recentMessages) {
        const roleLabel = msg.role === "user" ? "Visiteur" : "Lucie";
        // Truncate long messages
        const content = msg.content.length > 300
          ? msg.content.slice(0, 300) + "..."
          : msg.content;
        parts.push(`**${roleLabel}**: ${content}\n`);
      }
    }

    return parts.join("");
  }

  /**
   * Build summary prompt
   */
  private buildSummaryPrompt(messages: Array<{ role: string; content: string }>): string {
    const formattedMessages = messages
      .map((m) => `${m.role === "user" ? "Visiteur" : "Lucie"}: ${m.content}`)
      .join("\n\n");

    return `Resumes cette conversation entre un visiteur et Lucie (une developpeuse IA).
Garde les points cles: questions posees, sujets discutes, informations partagees.
Sois concis (2-3 phrases max).

Conversation:
${formattedMessages}

Resume:`;
  }

  /**
   * Extract integer from Neo4j result
   */
  private extractInt(value: any): number {
    if (!value) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "object" && "low" in value) return value.low;
    return parseInt(value.toString(), 10) || 0;
  }
}

// ============================================================================
// Route Registration
// ============================================================================

export function registerLucieRoutes(
  server: FastifyInstance,
  deps: { neo4j: Neo4jClient }
): void {
  const service = new LucieConversationService(deps.neo4j);

  // =========================================================================
  // POST /lucie/conversation - Get or create conversation for visitor
  // =========================================================================
  server.post<{
    Body: { visitorId: string };
  }>("/lucie/conversation", async (request, reply) => {
    const { visitorId } = request.body || {};

    if (!visitorId) {
      reply.status(400);
      return { success: false, error: "visitorId is required" };
    }

    try {
      const conversationId = await service.getOrCreateConversation(visitorId);
      const context = await service.getContext(conversationId);

      return {
        success: true,
        conversationId,
        totalMessages: context.totalMessages,
        summaryCount: context.summaries.length,
      };
    } catch (error: any) {
      console.error(`[Lucie] Failed to get/create conversation: ${error.message}`);
      reply.status(500);
      return { success: false, error: error.message };
    }
  });

  // =========================================================================
  // POST /lucie/message - Add message and get context
  // =========================================================================
  server.post<{
    Body: {
      visitorId: string;
      role: "user" | "assistant";
      content: string;
    };
  }>("/lucie/message", async (request, reply) => {
    const { visitorId, role, content } = request.body || {};

    if (!visitorId || !role || !content) {
      reply.status(400);
      return { success: false, error: "visitorId, role, and content are required" };
    }

    try {
      const conversationId = await service.getOrCreateConversation(visitorId);
      const { messageId, shouldSummarize } = await service.addMessage(
        conversationId,
        role,
        content
      );

      // Create summary if needed (async, don't block response)
      if (shouldSummarize) {
        service.createL1Summary(conversationId).catch((err) => {
          console.error(`[Lucie] Background summarization failed: ${err.message}`);
        });
      }

      return {
        success: true,
        conversationId,
        messageId,
        summarizing: shouldSummarize,
      };
    } catch (error: any) {
      console.error(`[Lucie] Failed to add message: ${error.message}`);
      reply.status(500);
      return { success: false, error: error.message };
    }
  });

  // =========================================================================
  // GET /lucie/context/:visitorId - Get conversation context
  // =========================================================================
  server.get<{
    Params: { visitorId: string };
  }>("/lucie/context/:visitorId", async (request, reply) => {
    const { visitorId } = request.params;

    if (!visitorId) {
      reply.status(400);
      return { success: false, error: "visitorId is required" };
    }

    try {
      const conversationId = `lucie-${visitorId}`;
      const context = await service.getContext(conversationId);
      const contextString = service.buildContextString(context);

      return {
        success: true,
        conversationId,
        context: contextString,
        summaries: context.summaries,
        recentMessages: context.recentMessages,
        totalMessages: context.totalMessages,
      };
    } catch (error: any) {
      console.error(`[Lucie] Failed to get context: ${error.message}`);
      reply.status(500);
      return { success: false, error: error.message };
    }
  });

  // =========================================================================
  // POST /lucie/summarize/:visitorId - Force create summary
  // =========================================================================
  server.post<{
    Params: { visitorId: string };
  }>("/lucie/summarize/:visitorId", async (request, reply) => {
    const { visitorId } = request.params;

    if (!visitorId) {
      reply.status(400);
      return { success: false, error: "visitorId is required" };
    }

    try {
      const conversationId = `lucie-${visitorId}`;
      const summary = await service.createL1Summary(conversationId);

      if (!summary) {
        return {
          success: true,
          message: "No summary created (not enough messages or already summarized)",
        };
      }

      return {
        success: true,
        summary,
      };
    } catch (error: any) {
      console.error(`[Lucie] Failed to create summary: ${error.message}`);
      reply.status(500);
      return { success: false, error: error.message };
    }
  });

  // =========================================================================
  // GET /lucie/history/:visitorId - Get full conversation history
  // =========================================================================
  server.get<{
    Params: { visitorId: string };
    Querystring: { limit?: string };
  }>("/lucie/history/:visitorId", async (request, reply) => {
    const { visitorId } = request.params;
    const limit = parseInt(request.query.limit || "50", 10);

    if (!visitorId) {
      reply.status(400);
      return { success: false, error: "visitorId is required" };
    }

    try {
      const conversationId = `lucie-${visitorId}`;

      const messagesResult = await deps.neo4j.run(
        `MATCH (c:LucieConversation {id: $conversationId})-[:HAS_MESSAGE]->(m:LucieMessage)
         RETURN m.id AS id, m.role AS role, m.content AS content, m.timestamp AS timestamp
         ORDER BY m.turnIndex ASC
         LIMIT toInteger($limit)`,
        { conversationId, limit: neo4jInt(limit) }
      );

      const messages = messagesResult.records.map((r) => ({
        id: r.get("id"),
        role: r.get("role"),
        content: r.get("content"),
        timestamp: r.get("timestamp")?.toString() || "",
      }));

      return {
        success: true,
        conversationId,
        messages,
        count: messages.length,
      };
    } catch (error: any) {
      console.error(`[Lucie] Failed to get history: ${error.message}`);
      reply.status(500);
      return { success: false, error: error.message };
    }
  });

  console.log("[Lucie] Conversation routes registered");
}
