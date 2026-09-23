import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { MainLayout } from "./main-layout";
import { SetupScreen } from "./setup-screen";
import { Skeleton } from "@ui/skeleton";
import { rpcClient } from "@lib/rpc";
import { useUpdateStore } from "@lib/update-store";

export function App() {
  const queryClient = useQueryClient();
  // 引导页点了「完成 / 跳过」就先放进主界面，不再等设置读回来：写 SETUP_COMPLETE
  // 失败、或读设置本身在报错时，否则会把人一直按在引导页上（引导页必须能绕过去）。
  const [setupEntered, setSetupEntered] = useState(false);

  useEffect(() => {
    rpcClient.getUpdateState().then(useUpdateStore.getState().setUpdateState);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => rpcClient.getSettings(),
  });

  if (isLoading && !setupEntered) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  if (!data?.configured && !setupEntered) {
    return (
      <SetupScreen
        onComplete={() => {
          setSetupEntered(true);
          void queryClient.invalidateQueries({ queryKey: ["settings"] });
        }}
      />
    );
  }

  return <MainLayout />;
}
