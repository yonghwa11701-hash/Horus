// Mirrors the initial SQL migration. Regenerate from the linked project after deployment:
// supabase gen types typescript --linked > src/types/database.ts
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Table<Row, Required extends keyof Row> = {
  Row: Row;
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      scribe_token_reservations: Table<{
        id: string;
        user_id: string;
        reserved_at: string;
      }, 'user_id'>;
      sessions: Table<{
        id: string;
        user_id: string;
        status: Database['public']['Enums']['session_status'];
        consented_at: string;
        created_at: string;
        updated_at: string;
        ended_at: string | null;
      }, 'user_id'>;
      transcript_segments: Table<{
        id: string;
        session_id: string;
        sequence: number;
        text: string;
        start_ms: number;
        end_ms: number;
        source: Database['public']['Enums']['transcript_source'];
        processing_status: Database['public']['Enums']['processing_status'];
        processed_at: string | null;
        created_at: string;
      }, 'id' | 'session_id' | 'sequence' | 'text' | 'start_ms' | 'end_ms'>;
      suggestions: Table<{
        question_id: string;
        session_id: string;
        question: string;
        priority: Database['public']['Enums']['suggestion_priority'];
        status: Database['public']['Enums']['suggestion_status'];
        source_segment_ids: string[];
        evaluation: Json;
        created_at: string;
        updated_at: string;
        resolved_at: string | null;
      }, 'session_id' | 'question' | 'priority' | 'source_segment_ids' | 'evaluation'>;
      agent_events: Table<{
        id: string;
        session_id: string;
        event_type: string;
        actor: 'user' | 'system';
        actor_user_id: string | null;
        artifact_id: string | null;
        metadata: Json;
        created_at: string;
      }, 'session_id' | 'event_type'>;
      session_artifacts: Table<{
        id: string;
        session_id: string;
        kind: Database['public']['Enums']['artifact_kind'];
        storage_path: string;
        schema_version: number;
        created_at: string;
      }, 'session_id' | 'kind' | 'storage_path'>;
      consultation_memory: Table<{
        session_id: string;
        understanding: Json | null;
        questions: Json;
        lock_id: string | null;
        locked_until: string | null;
        updated_at: string;
      }, 'session_id'>;
    };
    Views: { [_ in never]: never };
    Functions: {
      create_consultation: {
        Args: { p_id: string; p_consent: boolean };
        Returns: Database['public']['Tables']['sessions']['Row'][];
      };
      transition_consultation: {
        Args: { p_session_id: string; p_status: Database['public']['Enums']['session_status'] };
        Returns: Database['public']['Tables']['sessions']['Row'][];
      };
      append_transcript: {
        Args: {
          p_id: string; p_session_id: string; p_sequence: number; p_text: string;
          p_start_ms: number; p_end_ms: number;
          p_source: Database['public']['Enums']['transcript_source'];
        };
        Returns: Database['public']['Tables']['transcript_segments']['Row'][];
      };
      delete_discarded_consultation: {
        Args: { p_session_id: string };
        Returns: undefined;
      };
      reserve_scribe_token: {
        Args: { p_session_id: string };
        Returns: undefined;
      };
      claim_agent_memory: {
        Args: { p_session_id: string; p_lock_id: string; p_lease_seconds: number };
        Returns: Database['public']['Tables']['consultation_memory']['Row'][];
      };
      complete_consultation: {
        Args: { p_session_id: string };
        Returns: Database['public']['Tables']['sessions']['Row'][];
      };
    };
    Enums: {
      session_status: 'active' | 'paused' | 'ending' | 'completed' | 'discarding';
      suggestion_priority: 'low' | 'medium' | 'high' | 'critical';
      suggestion_status: 'approved' | 'resolved' | 'dismissed';
      processing_status: 'pending' | 'processing' | 'completed' | 'failed';
      artifact_kind: 'transcript' | 'understanding' | 'questions' | 'evaluation' | 'resolution' | 'summary' | 'audit';
      transcript_source: 'elevenlabs' | 'manual_demo';
    };
    CompositeTypes: { [_ in never]: never };
  };
};
