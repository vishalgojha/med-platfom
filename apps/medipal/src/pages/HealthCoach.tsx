import React, { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { appClient } from "@/api/appClient";
import { executeAgentWorkflow, type ExecuteAgentWorkflowResult } from "@/api/agentRouter";
import { Dumbbell, TrendingUp, MessageSquareQuote, Loader2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import { format } from "date-fns";
import PlanGenerator from "../components/coach/PlanGenerator";
import DailyCheckin from "../components/coach/DailyCheckin";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function HealthCoachPage() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [routingResult, setRoutingResult] = useState<ExecuteAgentWorkflowResult | null>(null);

  const { data: userProfile } = useQuery({
    queryKey: ["userProfile"],
    queryFn: () => appClient.entities.UserProfile.list({ limit: 1 }).then((res) => res[0]),
  });

  const { data: tests } = useQuery({
    queryKey: ["tests"],
    queryFn: () => appClient.entities.Test.list({ limit: 20 }),
  });

  const {
    data: activePlan,
    isLoading: isPlanLoading,
    refetch: refetchPlan,
  } = useQuery({
    queryKey: ["activePlan", refreshTrigger],
    queryFn: async () => {
      const plans = await appClient.entities.HealthPlan.list({
        limit: 1,
        sort: { created_date: -1 },
      });
      return plans.length > 0 && plans[0].status === "active" ? plans[0] : null;
    },
  });

  const { data: logs, refetch: refetchLogs } = useQuery({
    queryKey: ["healthLogs", refreshTrigger],
    queryFn: () => appClient.entities.HealthLog.list({ limit: 7, sort: { date: -1 } }),
  });

  const { data: reports } = useQuery({
    queryKey: ["reports"],
    queryFn: () => appClient.entities.Report.list({ limit: 5, sort: { date: -1 } }),
  });

  const routePlanMutation = useMutation({
    mutationFn: async () => {
      const doctorId = typeof userProfile?.id === "string" ? userProfile.id : "d_api";
      const latestLog = Array.isArray(logs) && logs.length > 0 ? logs[0] : null;
      const coachingContext = [
        activePlan?.title ? `Plan title: ${activePlan.title}` : "",
        activePlan?.type ? `Plan type: ${activePlan.type}` : "",
        latestLog?.notes ? `Latest note: ${latestLog.notes}` : "",
        latestLog?.mood ? `Latest mood: ${latestLog.mood}` : "",
        userProfile?.health_goals ? `Goals: ${userProfile.health_goals}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return executeAgentWorkflow({
        workflow: "triage_intake",
        specialtyId: "endocrinology",
        doctorId,
        payload: {
          query: coachingContext || "Generate coaching triage review for current diabetes management plan.",
        },
        dryRun: false,
        confirm: true,
      });
    },
    onSuccess: (response) => {
      setRoutingResult(response);
      toast.success(`Routed to ${response.leadAgent}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Unable to route coaching workflow");
    },
  });

  const handleRefresh = () => {
    setRefreshTrigger((prev) => prev + 1);
    refetchPlan();
    refetchLogs();
  };

  const handleArchivePlan = async () => {
    if (!activePlan) return;
    if (confirm("Are you sure you want to end this plan and start a new one?")) {
      await appClient.entities.HealthPlan.update(activePlan.id, { status: "archived" });
      handleRefresh();
    }
  };

  if (isPlanLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4 max-w-6xl">
        <div className="flex flex-col md:flex-row items-start gap-8">
          <div className="w-full md:w-2/3 space-y-8">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-2">
              <div className="flex items-center gap-3">
                <div className="bg-indigo-100 p-2 rounded-xl">
                  <Dumbbell className="w-6 h-6 text-indigo-600" />
                </div>
                <h1 className="text-3xl font-bold text-slate-900">Health Coach</h1>
              </div>
              <Button
                type="button"
                variant="outline"
                className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                onClick={() => routePlanMutation.mutate()}
                disabled={routePlanMutation.isPending}
              >
                {routePlanMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Routing...
                  </>
                ) : (
                  <>
                    <Workflow className="w-4 h-4 mr-2" />
                    Run AI Route
                  </>
                )}
              </Button>
            </div>

            {routingResult ? (
              <Card className="border-emerald-200 bg-emerald-50/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base text-emerald-900">Latest Routing Result</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-slate-700">
                    Lead agent: <span className="font-semibold">{routingResult.leadAgent}</span>
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    Steps: {routingResult.steps.map((step) => step.capability).join(" -> ")}
                  </p>
                </CardContent>
              </Card>
            ) : null}

            {!activePlan ? (
              <PlanGenerator userProfile={userProfile} tests={tests} reports={reports} onPlanCreated={handleRefresh} />
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="bg-gradient-to-r from-indigo-600 to-purple-600 p-6 text-white flex justify-between items-start">
                  <div>
                    <div className="uppercase tracking-wide text-xs font-bold bg-white/20 inline-block px-2 py-1 rounded mb-3">
                      Current {activePlan.type} Plan
                    </div>
                    <h2 className="text-2xl font-bold mb-2">{activePlan.title}</h2>
                    <p className="text-indigo-100 text-sm opacity-90">
                      Created on {new Date(activePlan.created_date).toLocaleDateString()}
                    </p>
                  </div>
                  <Button variant="ghost" className="text-white hover:bg-white/20" onClick={handleArchivePlan}>
                    End Plan
                  </Button>
                </div>
                <div className="p-6 prose prose-indigo max-w-none">
                  <ReactMarkdown>{activePlan.content}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>

          <div className="w-full md:w-1/3 space-y-6">
            {activePlan && <DailyCheckin userProfile={userProfile} onLogSubmitted={handleRefresh} />}

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-indigo-500" />
                Recent Progress
              </h3>

              <div className="space-y-4">
                {logs?.length === 0 && <p className="text-slate-400 text-sm">No logs yet. Start checking in!</p>}
                {logs?.map((log: any) => (
                  <div key={log.id} className="border-l-2 border-indigo-100 pl-4 pb-1 relative">
                    <div className="absolute -left-[5px] top-0 w-2 h-2 rounded-full bg-indigo-400" />
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        {format(new Date(log.date), "MMM dd")}
                      </span>
                      <span className="text-xs bg-slate-100 px-2 py-0.5 rounded text-slate-600">{log.mood}</span>
                    </div>
                    {log.notes && <p className="text-sm text-slate-700 mb-2 italic">"{log.notes}"</p>}
                    {log.ai_feedback && (
                      <div className="bg-indigo-50 p-2 rounded-lg text-xs text-indigo-800 flex gap-2">
                        <MessageSquareQuote className="w-4 h-4 flex-shrink-0 opacity-50" />
                        {log.ai_feedback}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
