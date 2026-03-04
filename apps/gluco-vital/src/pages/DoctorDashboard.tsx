import React, { useState, useEffect } from "react";
import { appClient } from "@/api/appClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { executeAgentWorkflow, getIndiaAgentDeploymentProfile } from "@/api/agentRouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Users, UserCheck, Clock, Activity, Droplet, Heart, TrendingUp, MessageCircle, FileText, Loader2, CheckCircle, AlertTriangle, UserPlus, Mail, Network, Workflow } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { format, subDays, isToday } from "date-fns";

export default function DoctorDashboard() {
  const [user, setUser] = useState(null);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteForm, setInviteForm] = useState({ patient_email: "", patient_name: "", message: "" });
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [routingConnectionId, setRoutingConnectionId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    appClient.auth.me().then(setUser).catch(() => {});
  }, []);

  const inviteMutation = useMutation({
    mutationFn: async (data) => {
      console.log('Sending invite with data:', data);
      const response = await appClient.functions.invoke('invitePatient', data);
      console.log('Invite response:', response);
      if (response.data?.error) {
        throw new Error(response.data.error);
      }
      return response.data;
    },
    onSuccess: (data) => {
      console.log('Invite success:', data);
      queryClient.invalidateQueries({ queryKey: ['doctor-patients'] });
      setInviteSuccess(true);
      if (!data.emailSent) {
        toast.warning(`Connection created but email failed: ${data.emailError || 'Unknown error'}`);
      }
    },
    onError: (error) => {
      console.error('Invite error:', error);
      toast.error(error?.response?.data?.error || error?.message || "Failed to send invitation");
    }
  });

  // Get connections where user is the doctor
  const { data: connections = [], isLoading: connectionsLoading } = useQuery({
    queryKey: ['doctor-patients', user?.email],
    queryFn: () => appClient.entities.DoctorConnection.filter({ doctor_email: user?.email }),
    enabled: !!user?.email
  });

  const pendingConnections = connections.filter(c => c.status === "pending");
  const activeConnections = connections.filter(c => c.status === "active");

  const { data: deploymentProfile } = useQuery({
    queryKey: ["gluco-vital-agent-profile", "en", "hi"],
    queryFn: () => getIndiaAgentDeploymentProfile(["en", "hi"]),
    staleTime: 10 * 60 * 1000,
  });

  const routeMutation = useMutation({
    mutationFn: async ({
      connection,
      context,
      severity,
    }: {
      connection: any;
      context: string;
      severity: "urgent" | "routine";
    }) => {
      const doctorId = typeof user?.id === "string" ? user.id : "d_api";
      const specialtyId = severity === "urgent" ? "endocrinology" : "family_medicine";

      return executeAgentWorkflow({
        workflow: "triage_intake",
        specialtyId,
        doctorId,
        payload: {
          query: context,
          patientEmail: connection.patient_email,
          patientName: connection.patient_name,
        },
        dryRun: false,
        confirm: true,
      });
    },
    onSuccess: (response, variables) => {
      toast.success(`Routed ${variables.connection.patient_name || "patient"} via ${response.leadAgent}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Unable to route this patient case");
    },
    onSettled: () => {
      setRoutingConnectionId(null);
    },
  });

  const acceptMutation = useMutation({
    mutationFn: (id) => appClient.entities.DoctorConnection.update(id, { 
      status: "active",
      accepted_at: new Date().toISOString()
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['doctor-patients'] });
      toast.success("Connection accepted!");
    }
  });

  const declineMutation = useMutation({
    mutationFn: (id) => appClient.entities.DoctorConnection.update(id, { status: "revoked" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['doctor-patients'] });
      toast.success("Connection declined");
    }
  });

  const handleRoutePatientCase = (payload: { connection: any; context: string; severity: "urgent" | "routine" }) => {
    setRoutingConnectionId(payload.connection.id);
    routeMutation.mutate(payload);
  };

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 md:py-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 md:mb-8">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-slate-800">Doctor Dashboard</h1>
            <p className="text-slate-500 text-sm mt-1">View and manage your patients' health data</p>
          </div>
          <Button onClick={() => setShowInviteDialog(true)} className="bg-[#5b9a8b] hover:bg-[#4a8a7b] w-full sm:w-auto">
            <UserPlus className="w-4 h-4 mr-2" />
            Invite Patient
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 sm:gap-4 mb-6 md:mb-8">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Users className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-800">{activeConnections.length}</p>
                  <p className="text-xs text-slate-500">Active Patients</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-100 rounded-lg">
                  <Clock className="w-5 h-5 text-amber-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-800">{pendingConnections.length}</p>
                  <p className="text-xs text-slate-500">Pending Requests</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="mb-6 border-emerald-200 bg-emerald-50/30">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Network className="w-4 h-4 text-emerald-700" />
              <p className="font-semibold text-emerald-900 text-sm">India Multi-Agent Deployment</p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-emerald-200 bg-white p-2">
                <p className="text-[11px] text-slate-500">Languages</p>
                <p className="text-sm font-semibold text-slate-900">{deploymentProfile?.primaryLanguages?.join(", ") || "--"}</p>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-white p-2">
                <p className="text-[11px] text-slate-500">Roles</p>
                <p className="text-sm font-semibold text-slate-900">{deploymentProfile?.roles?.length ?? 0}</p>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-white p-2">
                <p className="text-[11px] text-slate-500">Routes</p>
                <p className="text-sm font-semibold text-slate-900">{deploymentProfile?.routes?.length ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Pending Requests */}
        {pendingConnections.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <Clock className="w-5 h-5 text-amber-500" />
              Pending Connection Requests
            </h2>
            <div className="space-y-3">
              {pendingConnections.map(conn => (
                <Card key={conn.id} className="border-amber-200 bg-amber-50/50">
                  <CardContent className="p-3 sm:p-4">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                          <span className="font-semibold text-amber-700">
                            {conn.patient_name?.[0]?.toUpperCase() || "P"}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-slate-800 truncate">{conn.patient_name}</p>
                          <p className="text-sm text-slate-500 truncate">{conn.patient_email}</p>
                        </div>
                      </div>
                      <div className="flex gap-2 ml-auto sm:ml-0">
                        <Button
                          size="sm"
                          onClick={() => acceptMutation.mutate(conn.id)}
                          disabled={acceptMutation.isPending}
                          className="bg-green-600 hover:bg-green-700"
                        >
                          <CheckCircle className="w-4 h-4 sm:mr-1" />
                          <span className="hidden sm:inline">Accept</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => declineMutation.mutate(conn.id)}
                          className="text-red-600 border-red-200"
                        >
                          <span className="sm:hidden">✕</span>
                          <span className="hidden sm:inline">Decline</span>
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Active Patients */}
        <div>
          <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-green-500" />
            Your Patients
          </h2>

          {connectionsLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
            </div>
          ) : activeConnections.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-12 text-center">
                <Users className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-500">No active patients yet</p>
                <p className="text-sm text-slate-400 mt-1">Invite patients or wait for them to connect from their app</p>
                <Button onClick={() => setShowInviteDialog(true)} className="mt-4" variant="outline">
                  <UserPlus className="w-4 h-4 mr-2" />
                  Invite Your First Patient
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {activeConnections.map(conn => (
                <PatientCard
                  key={conn.id}
                  connection={conn}
                  onRouteCase={handleRoutePatientCase}
                  routingInProgress={routeMutation.isPending && routingConnectionId === conn.id}
                />
              ))}
            </div>
          )}
        </div>

        {/* Invite Patient Dialog */}
        <Dialog open={showInviteDialog} onOpenChange={(open) => {
          setShowInviteDialog(open);
          if (!open) {
            setInviteSuccess(false);
            setInviteForm({ patient_email: "", patient_name: "", message: "" });
          }
        }}>
          <DialogContent className="max-w-md">
            {inviteSuccess ? (
              <div className="py-8 text-center">
                <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="w-8 h-8 text-green-600" />
                </div>
                <h3 className="text-xl font-semibold text-slate-800 mb-2">Invitation Sent!</h3>
                <p className="text-slate-600 mb-1">
                  An email has been sent to <strong>{inviteForm.patient_email}</strong>
                </p>
                <p className="text-sm text-slate-500 mb-6">
                  They'll appear in your pending list once they accept.
                </p>
                <Button 
                  onClick={() => {
                    setShowInviteDialog(false);
                    setInviteSuccess(false);
                    setInviteForm({ patient_email: "", patient_name: "", message: "" });
                  }}
                  className="bg-[#5b9a8b] hover:bg-[#4a8a7b]"
                >
                  Done
                </Button>
              </div>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Mail className="w-5 h-5 text-[#5b9a8b]" />
                    Invite Patient
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label>Patient Email *</Label>
                    <Input
                      type="email"
                      value={inviteForm.patient_email}
                      onChange={(e) => setInviteForm(prev => ({ ...prev, patient_email: e.target.value }))}
                      placeholder="patient@example.com"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>Patient Name (optional)</Label>
                    <Input
                      value={inviteForm.patient_name}
                      onChange={(e) => setInviteForm(prev => ({ ...prev, patient_name: e.target.value }))}
                      placeholder="John Doe"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>Personal Message (optional)</Label>
                    <Textarea
                      value={inviteForm.message}
                      onChange={(e) => setInviteForm(prev => ({ ...prev, message: e.target.value }))}
                      placeholder="Hi, I'd like to monitor your health data through Gluco Vital..."
                      className="mt-1 h-20"
                    />
                  </div>
                  <div className="bg-blue-50 p-3 rounded-lg text-sm text-blue-700">
                    <p className="font-medium">What happens next:</p>
                    <ul className="mt-1 text-xs space-y-1">
                      <li>• Patient receives an email invitation</li>
                      <li>• They sign up (if new) and accept the connection</li>
                      <li>• Once accepted, you can view their health data</li>
                    </ul>
                  </div>
                  <Button 
                    onClick={() => inviteMutation.mutate(inviteForm)}
                    disabled={!inviteForm.patient_email || inviteMutation.isPending}
                    className="w-full bg-[#5b9a8b] hover:bg-[#4a8a7b]"
                  >
                    {inviteMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : (
                      <Mail className="w-4 h-4 mr-2" />
                    )}
                    Send Invitation
                  </Button>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function PatientCard({
  connection,
  onRouteCase,
  routingInProgress = false,
}: {
  connection: any;
  onRouteCase: (payload: { connection: any; context: string; severity: "urgent" | "routine" }) => void;
  routingInProgress?: boolean;
}) {
  const { data: logs = [] } = useQuery({
    queryKey: ['patient-logs', connection.patient_email],
    queryFn: () => appClient.entities.HealthLog.filter(
      { user_email: connection.patient_email },
      '-created_date',
      50
    ),
    enabled: connection.permissions?.includes('view_logs')
  });

  const { data: profile } = useQuery({
    queryKey: ['patient-profile', connection.patient_email],
    queryFn: () => appClient.entities.PatientProfile.filter({ user_email: connection.patient_email }),
    select: data => data?.[0]
  });

  const sugarLogs = logs.filter(l => l.log_type === "sugar" && l.numeric_value);
  const lastSugar = sugarLogs[0]?.numeric_value;
  const avgSugar = sugarLogs.length > 0
    ? Math.round(sugarLogs.slice(0, 7).reduce((a, b) => a + b.numeric_value, 0) / Math.min(sugarLogs.length, 7))
    : null;

  const bpLogs = logs.filter(l => l.log_type === "blood_pressure");
  const lastBP = bpLogs[0]?.value;

  const todayLogs = logs.filter(l => isToday(new Date(l.created_date)));

  // Check for concerning values
  const hasHighSugar = lastSugar && lastSugar > 180;
  const hasLowSugar = lastSugar && lastSugar < 70;
  const routeSeverity: "urgent" | "routine" = hasHighSugar || hasLowSugar ? "urgent" : "routine";
  const routeContext = [
    `Patient: ${connection.patient_name || "Unknown"}`,
    `Latest sugar: ${lastSugar ?? "N/A"}`,
    `7-day sugar average: ${avgSugar ?? "N/A"}`,
    `Latest blood pressure: ${lastBP ?? "N/A"}`,
    hasHighSugar ? "Flag: hyperglycemia risk" : "",
    hasLowSugar ? "Flag: hypoglycemia risk" : "",
    logs[0]?.notes ? `Recent note: ${logs[0].notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Card className={`hover:shadow-md transition-shadow ${hasHighSugar || hasLowSugar ? 'border-red-200' : ''}`}>
      <CardContent className="p-3 sm:p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#5b9a8b]/20 to-[#7eb8a8]/20 flex items-center justify-center">
              <span className="text-lg font-semibold text-[#5b9a8b]">
                {connection.patient_name?.[0]?.toUpperCase() || "P"}
              </span>
            </div>
            <div>
              <h3 className="font-semibold text-slate-800">{connection.patient_name}</h3>
              <p className="text-sm text-slate-500">
                {profile?.age ? `${profile.age} yrs` : ""} 
                {profile?.conditions?.length > 0 && ` • ${profile.conditions.join(", ")}`}
              </p>
            </div>
          </div>
          {(hasHighSugar || hasLowSugar) && (
            <Badge className="bg-red-100 text-red-700">
              <AlertTriangle className="w-3 h-3 mr-1" />
              Alert
            </Badge>
          )}
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4">
          <div className="p-2 sm:p-3 bg-blue-50 rounded-lg text-center">
            <Droplet className="w-3 h-3 sm:w-4 sm:h-4 text-blue-500 mx-auto mb-1" />
            <p className={`text-base sm:text-lg font-bold ${hasHighSugar ? 'text-red-600' : hasLowSugar ? 'text-amber-600' : 'text-slate-800'}`}>
              {lastSugar || "--"}
            </p>
            <p className="text-[10px] sm:text-xs text-slate-500">Last Sugar</p>
          </div>
          <div className="p-2 sm:p-3 bg-red-50 rounded-lg text-center">
            <Heart className="w-3 h-3 sm:w-4 sm:h-4 text-red-500 mx-auto mb-1" />
            <p className="text-base sm:text-lg font-bold text-slate-800">{lastBP || "--"}</p>
            <p className="text-[10px] sm:text-xs text-slate-500">Last BP</p>
          </div>
          <div className="p-2 sm:p-3 bg-green-50 rounded-lg text-center">
            <TrendingUp className="w-3 h-3 sm:w-4 sm:h-4 text-green-500 mx-auto mb-1" />
            <p className="text-base sm:text-lg font-bold text-slate-800">{avgSugar || "--"}</p>
            <p className="text-[10px] sm:text-xs text-slate-500">7-Day Avg</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between text-xs sm:text-sm text-slate-500 mb-4 gap-1">
          <span>{todayLogs.length} logs today</span>
          <span className="truncate">Last: {logs[0] ? format(new Date(logs[0].created_date), "MMM d, h:mm a") : "Never"}</span>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <Link to={createPageUrl(`PatientDetail?email=${connection.patient_email}&connection=${connection.id}`)} className="flex-1 min-w-[120px]">
            <Button variant="outline" className="w-full" size="sm">
              <Activity className="w-4 h-4 mr-1" />
              <span className="hidden xs:inline">View</span> Details
            </Button>
          </Link>
          <Link to={createPageUrl(`DoctorMessages?connection=${connection.id}`)}>
            <Button variant="outline" size="sm">
              <MessageCircle className="w-4 h-4" />
            </Button>
          </Link>
          <Link to={createPageUrl(`DoctorFeedback?connection=${connection.id}`)}>
            <Button size="sm" className="bg-[#5b9a8b] hover:bg-[#4a8a7b]">
              <FileText className="w-4 h-4 sm:mr-1" />
              <span className="hidden sm:inline">Feedback</span>
            </Button>
          </Link>
          <Button
            size="sm"
            variant="outline"
            className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
            onClick={() => onRouteCase({ connection, context: routeContext, severity: routeSeverity })}
            disabled={routingInProgress}
          >
            {routingInProgress ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin sm:mr-1" />
                <span className="hidden sm:inline">Routing</span>
              </>
            ) : (
              <>
                <Workflow className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">AI Route</span>
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
