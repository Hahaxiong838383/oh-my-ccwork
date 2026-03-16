import re
import pandas as pd
import os

def analyze_ieee_data(file_path):
    if not os.path.exists(file_path):
        return None
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    data = []
    # Find all "articleNumber" blocks
    blocks = re.split(r'"articleNumber":', content)
    for block in blocks[1:]: # Skip the first part before the first article
        title_m = re.search(r'"title":\s*"([^"]+)"', block)
        year_m = re.search(r'"publicationYear":\s*"([^"]+)"', block)
        if title_m:
            title = title_m.group(1)
            year = year_m.group(1).strip() if year_m else "Unknown"
            data.append({"title": title, "year": year})
    
    df = pd.DataFrame(data)
    return df

if __name__ == "__main__":
    df = analyze_ieee_data('ieee_results.html')
    if df is not None and not df.empty:
        # Filter out clearly non-title entries (some JSON structures use 'title' for other things)
        # Usually titles are long
        df = df[df['title'].str.len() > 10].drop_duplicates().reset_index(drop=True)
        
        print(f"Total unique articles found: {len(df)}")
        
        print("\nYearly Distribution:")
        dist = df['year'].value_counts().sort_index()
        print(dist.to_string())
        
        # Look for keywords in titles
        keywords = ['AI', 'LLM', 'Agent', 'Network', 'Security', 'Deep Learning', 'Machine Learning']
        keyword_counts = {}
        for kw in keywords:
            keyword_counts[kw] = df['title'].str.contains(kw, case=False).sum()
        
        print("\nKeyword Frequency in Titles:")
        for kw, count in keyword_counts.items():
            print(f"{kw}: {count}")
        
        if not os.path.exists('.omc/scientist/'):
            os.makedirs('.omc/scientist/', exist_ok=True)
        df.to_csv('.omc/scientist/extracted_ieee_data.csv', index=False)
    else:
        print("No data extracted.")
