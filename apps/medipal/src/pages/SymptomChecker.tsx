import React, { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { appClient } from "@/api/appClient";
import {
  executeAgentWorkflow,
  getIndiaAgentDeploymentProfile,
  listSpecialties,
  type ExecuteAgentWorkflowResult,
} from "@/api/agentRouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, Stethoscope, AlertTriangle, Sparkles, Network, Workflow } from "lucide-react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import TestCard from "../components/TestCard";

export default function SymptomCheckerPage() {
  const [symptoms, setSymptoms] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [routingResult, setRoutingResult] = useState<ExecuteAgentWorkflowResult | null>(null);

  const { data: tests } = useQuery({
    queryKey: ["tests"],
    queryFn: () => appClient.entities.Test.list({ limit: 100 }),
  });

  const { data: userProfile } = useQuery({
    queryKey: ["userProfile"],
    queryFn: () => appClient.entities.UserProfile.list({ limit: 1 }).then((res) => res[0]),
  });

  const { data: reports } = useQuery({
    queryKey: ["reports"],
    queryFn: () => appClient.entities.Report.list({ limit: 5, sort: { date: -1 } }),
  });

  const { data: specialtyDirectory } = useQuery({
    queryKey: ["medipal-agent-specialties", "clinic", "en"],
    queryFn: () => listSpecialties({ setting: "clinic", language: "en" }),
    staleTime: 5 * 60 * 1000,
  });

  const { data: deploymentProfile } = useQuery({
    queryKey: ["medipal-agent-profile", "en", "hi"],
    queryFn: () => getIndiaAgentDeploymentProfile(["en", "hi"]),
    staleTime: 10 * 60 * 1000,
  });

  const routeMutation = useMutation({
    mutationFn: async () => {
      const lowerSymptoms = symptoms.toLowerCase();
      const emergencyKeywords = ["chest pain", "breath", "faint", "bleeding", "stroke", "seizure", "unconscious"];
      const specialtyId = emergencyKeywords.some((token) => lowerSymptoms.includes(token))
        ? "emergency_medicine"
        : "family_medicine";
      const doctorId = typeof userProfile?.id === "string" ? userProfile.id : "d_api";
      const context = [
        `Symptoms: ${symptoms}`,
        result?.analysis ? `MediPal analysis: ${result.analysis}` : "",
        result?.recommendation_reasoning ? `Reasoning: ${result.recommendation_reasoning}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return executeAgentWorkflow({
        workflow: "triage_intake",
        specialtyId,
        doctorId,
        payload: {
          query: context,
        },
        dryRun: false,
        confirm: true,
      });
    },
    onSuccess: (response) => {
      setRoutingResult(response);
      toast.success(`Routed with ${response.leadAgent}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Routing failed");
    },
  });

  const handleAnalyze = async () => {
    if (!symptoms.trim()) {
      toast.error("Please describe your symptoms first");
      return;
    }

    setIsAnalyzing(true);
    setResult(null);

    try {
      const testsList = tests
        ?.map((t: any) => ({ id: t.id, name: t.name, explanation: t.simple_explanation }))
        .map(JSON.stringify)
        .join("\n");
      const reportsContext =
        reports?.map((r: any) => `${r.test_name} (${r.date}): ${r.summary}`).join("; ") || "No recent reports";

      const prompt = `
        You are MediPal's Symptom Checker AI 🩺.
        
        User Profile:
        - Name: ${userProfile?.nickname || "User"}
        - Goals: ${userProfile?.health_goals || "N/A"}
        - Concerns: ${userProfile?.health_concerns || "N/A"}
        - Past Reports: ${reportsContext}

        Current Symptoms: "${symptoms}"

        Available Tests in our catalog:
        ${testsList}

        Task:
        1. Analyze the symptoms with empathy, considering their health history and past reports (e.g., if they previously had low iron and now feel tired, mention that).
        2. Suggest 1-3 *specific* tests from the provided catalog that might be relevant to investigate the new symptoms or follow up on old ones.
        3. Explain WHY each test is relevant in simple, comforting terms, referencing their history if applicable.
        4. Provide a general disclaimer that you are an AI, not a doctor.
        
        Output Format (JSON only):
        {
          "empathetic_response": "string (warm opening acknowledging their feelings)",
          "analysis": "string (brief, non-alarming explanation of what might be going on)",
          "recommended_test_ids": ["test_id_1", "test_id_2"],
          "recommendation_reasoning": "string (why these tests?)",
          "disclaimer": "string (mandatory medical disclaimer)"
        }
      `;

      const response = await appClient.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: "object",
          properties: {
            empathetic_response: { type: "string" },
            analysis: { type: "string" },
            recommended_test_ids: { type: "array", items: { type: "string" } },
            recommendation_reasoning: { type: "string" },
            disclaimer: { type: "string" },
          },
          required: ["empathetic_response", "analysis", "recommended_test_ids", "disclaimer"],
        },
      });

      setResult(response);
    } catch (error) {
      console.error("Analysis failed:", error);
      toast.error("Sorry, I couldn't analyze that right now. Please try again.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleAddToCart = async (test: any) => {
    try {
      await appClient.entities.CartItem.create({
        test_name: test.name,
        price: test.price,
        status: "in_cart",
      });
      toast.success(`Added ${test.name} to your cart!`);
    } catch (_error) {
      toast.error("Could not add to cart.");
    }
  };

  const recommendedTests = tests?.filter((t: any) => result?.recommended_test_ids?.includes(t.id));

  return (
    <div className="min-h-screen bg-slate-50 py-12">
      <div className="container mx-auto px-4 max-w-3xl">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center p-3 bg-indigo-100 rounded-full mb-4">
            <Stethoscope className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-4xl font-bold text-slate-900 mb-4">Symptom Checker</h1>
          <p className="text-lg text-slate-600">
            Describe how you're feeling, and I'll suggest some checkups that might help.
          </p>
        </div>

        <Card className="mb-6 border-emerald-200 bg-emerald-50/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-emerald-900 flex items-center gap-2">
              <Network className="w-4 h-4" />
              India Multi-Agent Routing
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-emerald-200 bg-white p-3">
                <p className="text-xs text-slate-500">Specialties</p>
                <p className="text-lg font-semibold text-slate-900">{specialtyDirectory?.length ?? 0}</p>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-white p-3">
                <p className="text-xs text-slate-500">Routes</p>
                <p className="text-lg font-semibold text-slate-900">{deploymentProfile?.routes.length ?? 0}</p>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-white p-3">
                <p className="text-xs text-slate-500">Agent Roles</p>
                <p className="text-lg font-semibold text-slate-900">{deploymentProfile?.roles.length ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-8 border-indigo-100 shadow-lg">
          <CardHeader className="bg-indigo-50/50 border-b border-indigo-50">
            <CardTitle className="text-indigo-900">How are you feeling today?</CardTitle>
            <CardDescription>
              Be as specific as you can. For example: "I've been feeling unusually tired lately and my hair is thinning."
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <Textarea
              value={symptoms}
              onChange={(e) => setSymptoms(e.target.value)}
              placeholder="Type your symptoms here..."
              className="min-h-[150px] text-lg mb-4 focus:ring-indigo-500"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Button
                onClick={handleAnalyze}
                disabled={isAnalyzing || !symptoms.trim()}
                className="h-12 text-lg bg-indigo-600 hover:bg-indigo-700 shadow-md shadow-indigo-200"
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Analyzing...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-5 w-5" /> Check Symptoms
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => routeMutation.mutate()}
                disabled={routeMutation.isPending || !symptoms.trim()}
                className="h-12 text-lg border-emerald-300 text-emerald-700 hover:bg-emerald-50"
              >
                {routeMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Routing...
                  </>
                ) : (
                  <>
                    <Workflow className="mr-2 h-5 w-5" /> Run AI Route
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {routingResult ? (
          <Card className="mb-8 border-emerald-200 bg-white">
            <CardHeader>
              <CardTitle className="text-emerald-900">Routing Result</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600">
                Routed to <span className="font-semibold text-slate-900">{routingResult.leadAgent}</span> for{" "}
                <span className="font-semibold text-slate-900">{routingResult.specialtyName}</span>.
              </p>
              <p className="text-xs text-slate-500 mt-2">
                Steps: {routingResult.steps.map((step) => step.capability).join(" -> ")}
              </p>
            </CardContent>
          </Card>
        ) : null}

        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-200">
                <h3 className="text-xl font-bold text-slate-800 mb-4 flex items-center gap-2">
                  <span className="text-2xl">🩺</span> MediPal's Thoughts
                </h3>
                <p className="text-indigo-600 font-medium text-lg mb-4">{result.empathetic_response}</p>
                <p className="text-slate-600 leading-relaxed mb-6">{result.analysis}</p>
                <div className="bg-slate-50 p-4 rounded-lg border-l-4 border-indigo-500">
                  <p className="text-sm text-slate-600 italic">"{result.recommendation_reasoning}"</p>
                </div>
              </div>

              {recommendedTests?.length > 0 && (
                <div>
                  <h3 className="text-xl font-bold text-slate-900 mb-6">Recommended Checkups</h3>
                  <div className="grid md:grid-cols-2 gap-6">
                    {recommendedTests.map((test: any) => (
                      <TestCard key={test.id} test={test} onAddToCart={handleAddToCart} />
                    ))}
                  </div>
                </div>
              )}

              <Alert variant="destructive" className="bg-amber-50 border-amber-200 text-amber-900">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
                <AlertTitle className="text-amber-800 font-bold ml-2">Important Medical Disclaimer</AlertTitle>
                <AlertDescription className="text-amber-700 ml-2 mt-1">
                  {result.disclaimer}
                  <br />
                  <strong>Always consult with a qualified healthcare provider for diagnosis and treatment.</strong>
                </AlertDescription>
              </Alert>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
