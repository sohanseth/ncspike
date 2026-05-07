export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      chat_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          metadata: Json
          role: Database["public"]["Enums"]["message_role"]
          thread_id: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          metadata?: Json
          role: Database["public"]["Enums"]["message_role"]
          thread_id: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          metadata?: Json
          role?: Database["public"]["Enums"]["message_role"]
          thread_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "chat_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_threads: {
        Row: {
          created_at: string
          id: string
          model: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          model?: string | null
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          model?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      connections: {
        Row: {
          access_token_encrypted: string | null
          account_label: string | null
          created_at: string
          expires_at: string | null
          id: string
          metadata: Json
          provider: Database["public"]["Enums"]["connection_provider"]
          refresh_token_encrypted: string | null
          scopes: string[] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_encrypted?: string | null
          account_label?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          metadata?: Json
          provider: Database["public"]["Enums"]["connection_provider"]
          refresh_token_encrypted?: string | null
          scopes?: string[] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token_encrypted?: string | null
          account_label?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          metadata?: Json
          provider?: Database["public"]["Enums"]["connection_provider"]
          refresh_token_encrypted?: string | null
          scopes?: string[] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      drafts: {
        Row: {
          body_encrypted: string
          chars_edited: number | null
          chars_in_draft: number
          created_at: string
          id: string
          resolved_at: string | null
          source_node_id: string | null
          status: string
          template: string
          templates_tried: string[]
          user_id: string
        }
        Insert: {
          body_encrypted: string
          chars_edited?: number | null
          chars_in_draft?: number
          created_at?: string
          id?: string
          resolved_at?: string | null
          source_node_id?: string | null
          status?: string
          template: string
          templates_tried?: string[]
          user_id: string
        }
        Update: {
          body_encrypted?: string
          chars_edited?: number | null
          chars_in_draft?: number
          created_at?: string
          id?: string
          resolved_at?: string | null
          source_node_id?: string | null
          status?: string
          template?: string
          templates_tried?: string[]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "drafts_source_node_id_fkey"
            columns: ["source_node_id"]
            isOneToOne: false
            referencedRelation: "memory_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      research_tasks: {
        Row: {
          completed_at: string | null
          created_at: string
          error: string | null
          id: string
          input: Json
          input_key: string
          priority: number
          read_at: string | null
          result: Json | null
          scheduled_for: string
          source: string
          source_context: string | null
          started_at: string | null
          status: string
          tool_id: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          input?: Json
          input_key: string
          priority?: number
          read_at?: string | null
          result?: Json | null
          scheduled_for?: string
          source?: string
          source_context?: string | null
          started_at?: string | null
          status?: string
          tool_id: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          input?: Json
          input_key?: string
          priority?: number
          read_at?: string | null
          result?: Json | null
          scheduled_for?: string
          source?: string
          source_context?: string | null
          started_at?: string | null
          status?: string
          tool_id?: string
          user_id?: string
        }
        Relationships: []
      }
      memory_edges: {
        Row: {
          created_at: string
          data: Json
          from_node: string
          id: string
          relation: string
          to_node: string
          user_id: string
        }
        Insert: {
          created_at?: string
          data?: Json
          from_node: string
          id?: string
          relation: string
          to_node: string
          user_id: string
        }
        Update: {
          created_at?: string
          data?: Json
          from_node?: string
          id?: string
          relation?: string
          to_node?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_edges_from_node_fkey"
            columns: ["from_node"]
            isOneToOne: false
            referencedRelation: "memory_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_edges_to_node_fkey"
            columns: ["to_node"]
            isOneToOne: false
            referencedRelation: "memory_nodes"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_nodes: {
        Row: {
          created_at: string
          data: Json
          id: string
          importance: number
          label: string
          node_type: Database["public"]["Enums"]["node_type"]
          source: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          data?: Json
          id?: string
          importance?: number
          label: string
          node_type: Database["public"]["Enums"]["node_type"]
          source?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          data?: Json
          id?: string
          importance?: number
          label?: string
          node_type?: Database["public"]["Enums"]["node_type"]
          source?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_endpoints: {
        Row: {
          db_url_encrypted: string | null
          model_key_encrypted: string | null
          model_url_encrypted: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          db_url_encrypted?: string | null
          model_key_encrypted?: string | null
          model_url_encrypted?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          db_url_encrypted?: string | null
          model_key_encrypted?: string | null
          model_url_encrypted?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          ai_mode: Database["public"]["Enums"]["ai_mode"]
          created_at: string
          preferred_model: string
          storage_mode: Database["public"]["Enums"]["storage_mode"]
          updated_at: string
          user_id: string
          voice_drafts_consent_at: string | null
        }
        Insert: {
          ai_mode?: Database["public"]["Enums"]["ai_mode"]
          created_at?: string
          preferred_model?: string
          storage_mode?: Database["public"]["Enums"]["storage_mode"]
          updated_at?: string
          user_id: string
          voice_drafts_consent_at?: string | null
        }
        Update: {
          ai_mode?: Database["public"]["Enums"]["ai_mode"]
          created_at?: string
          preferred_model?: string
          storage_mode?: Database["public"]["Enums"]["storage_mode"]
          updated_at?: string
          user_id?: string
          voice_drafts_consent_at?: string | null
        }
        Relationships: []
      }
      voice_profiles: {
        Row: {
          built_at: string
          expires_at: string
          id: string
          profile_encrypted: string | null
          sample_count: number
          user_id: string
        }
        Insert: {
          built_at?: string
          expires_at?: string
          id?: string
          profile_encrypted?: string | null
          sample_count?: number
          user_id: string
        }
        Update: {
          built_at?: string
          expires_at?: string
          id?: string
          profile_encrypted?: string | null
          sample_count?: number
          user_id?: string
        }
        Relationships: []
      }
      watchers: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          kind: string
          last_result: Json | null
          last_run_at: string | null
          rule: Json
          target: string
          user_id: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          kind: string
          last_result?: Json | null
          last_run_at?: string | null
          rule?: Json
          target: string
          user_id: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          kind?: string
          last_result?: Json | null
          last_run_at?: string | null
          rule?: Json
          target?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      ai_mode: "hosted_proprietary" | "hosted_oss" | "byo"
      connection_provider:
        | "gmail"
        | "google_calendar"
        | "google_drive"
        | "slack"
        | "notion"
        | "outlook"
        | "whatsapp"
      message_role: "system" | "user" | "assistant" | "tool"
      node_type:
        | "person"
        | "project"
        | "product"
        | "preference"
        | "priority"
        | "event"
        | "note"
        | "thread"
        | "other"
      storage_mode: "standard" | "private" | "sovereign"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      ai_mode: ["hosted_proprietary", "hosted_oss", "byo"],
      connection_provider: [
        "gmail",
        "google_calendar",
        "google_drive",
        "slack",
        "notion",
        "outlook",
        "whatsapp",
      ],
      message_role: ["system", "user", "assistant", "tool"],
      node_type: [
        "person",
        "project",
        "product",
        "preference",
        "priority",
        "event",
        "note",
        "thread",
        "other",
      ],
      storage_mode: ["standard", "private", "sovereign"],
    },
  },
} as const
