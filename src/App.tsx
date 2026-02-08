import { BookTable } from "./components/BookTable";
import { BookSearch } from "./components/BookSearch";
import { useState } from "react";
import "./index.css";

export function App() {
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <div className="container mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold mb-8">Calibre Library</h1>
      <div className="mb-6">
        <BookSearch onSearch={setSearchQuery} />
      </div>
      <BookTable searchQuery={searchQuery} />
    </div>
  );
}

export default App;
