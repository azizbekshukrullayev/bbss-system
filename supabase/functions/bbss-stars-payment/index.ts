const corsHeaders = {
  "Access-Control-Allow-Origin": "https://azizbekshukrullayev.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Vary": "Origin",
};

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  return new Response(
    JSON.stringify({
      ok: false,
      code: "PAYMENT_PROVIDER_DISABLED",
      error: "Bu to‘lov integratsiyasi BBSS SYSTEM’da o‘chirilgan. Kursga kirish admin tomonidan alohida tasdiqlanadi.",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
    },
  );
});
