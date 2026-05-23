import { BrowserRouter, Routes, Route } from "react-router";
import { Home } from "./components/Home";
import { DiffView } from "./components/DiffView";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/local" element={<DiffView source="local" />} />
        <Route path="/:org/:repo/pull/:number" element={<DiffView />} />
      </Routes>
    </BrowserRouter>
  );
}
