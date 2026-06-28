use std::{fs, path::Path};

use super::super::types::{VercelDeployOptions, VercelProjectMetadata};

pub fn find_deployment_url(
    output: &str,
    options: &VercelDeployOptions,
    project_dir: &Path,
) -> Option<String> {
    let urls = output
        .split_whitespace()
        .filter_map(extract_https_url)
        .collect::<Vec<_>>();

    if options.target == "production" {
        if let Some(production_url) = output
            .lines()
            .filter(|line| line.to_ascii_lowercase().contains("production"))
            .flat_map(extract_https_urls)
            .find(|url| !is_vercel_dashboard_url(url))
        {
            return Some(prefer_stable_production_url(&production_url, project_dir));
        }

        if let Some(url) = urls.iter().rev().find(|url| !is_vercel_dashboard_url(url)) {
            return Some(prefer_stable_production_url(url, project_dir));
        }
    }

    urls.iter()
        .rev()
        .find(|url| !is_vercel_dashboard_url(url))
        .cloned()
        .or_else(|| urls.into_iter().last())
}

fn extract_https_url(value: &str) -> Option<String> {
    let start = value.find("https://")?;
    let url = value[start..]
        .chars()
        .take_while(|character| {
            !character.is_whitespace()
                && *character != '"'
                && *character != '\''
                && *character != '<'
                && *character != '>'
                && *character != ')'
                && *character != ']'
                && *character != ','
        })
        .collect::<String>()
        .trim_end_matches(['.', ';', ':'])
        .to_string();

    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

fn extract_https_urls(line: &str) -> Vec<String> {
    line.split_whitespace()
        .filter_map(extract_https_url)
        .collect()
}

fn is_vercel_dashboard_url(url: &str) -> bool {
    url.starts_with("https://vercel.com/")
}

fn prefer_stable_production_url(url: &str, project_dir: &Path) -> String {
    stable_production_url_from_generated_url(url, project_dir).unwrap_or_else(|| url.to_string())
}

fn stable_production_url_from_generated_url(url: &str, project_dir: &Path) -> Option<String> {
    let host = url
        .strip_prefix("https://")?
        .split(['/', '?', '#'])
        .next()?
        .strip_suffix(".vercel.app")?;
    let project_name = read_vercel_project_name(project_dir)?;
    let tail = host.strip_prefix(&format!("{project_name}-"))?;
    let (unique_hash, scope_slug) = tail.split_once('-')?;

    if unique_hash.len() < 6
        || !unique_hash
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
        || scope_slug.trim().is_empty()
    {
        return None;
    }

    Some(format!("https://{project_name}-{scope_slug}.vercel.app"))
}

fn read_vercel_project_name(project_dir: &Path) -> Option<String> {
    let metadata_path = project_dir.join(".vercel").join("project.json");
    let content = fs::read_to_string(metadata_path).ok()?;
    let metadata = serde_json::from_str::<VercelProjectMetadata>(&content).ok()?;
    let project_name = metadata.project_name?.trim().to_string();

    if project_name.is_empty() {
        None
    } else {
        Some(project_name)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    #[test]
    fn production_deploy_prefers_stable_project_domain() {
        let project_dir = create_temp_vercel_project("test");
        let options = VercelDeployOptions {
            token: "test-token".to_string(),
            scope: None,
            project_name: None,
            target: "production".to_string(),
        };
        let output = "\
Inspect: https://vercel.com/huwenlong-s-projects/test/abc
Production: https://test-4hl6el33y-huwenlong-s-projects.vercel.app
";

        let url = find_deployment_url(output, &options, &project_dir)
            .expect("deployment URL should be found");

        assert_eq!(url, "https://test-huwenlong-s-projects.vercel.app");

        let _ = fs::remove_dir_all(project_dir);
    }

    #[test]
    fn preview_deploy_keeps_specific_deployment_url() {
        let project_dir = create_temp_vercel_project("test");
        let options = VercelDeployOptions {
            token: "test-token".to_string(),
            scope: None,
            project_name: None,
            target: "preview".to_string(),
        };
        let output = "https://test-4hl6el33y-huwenlong-s-projects.vercel.app";

        let url = find_deployment_url(output, &options, &project_dir)
            .expect("deployment URL should be found");

        assert_eq!(
            url,
            "https://test-4hl6el33y-huwenlong-s-projects.vercel.app"
        );

        let _ = fs::remove_dir_all(project_dir);
    }

    fn create_temp_vercel_project(project_name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        let project_dir = std::env::temp_dir().join(format!("nocodebuilder-vercel-test-{nonce}"));
        let vercel_dir = project_dir.join(".vercel");

        fs::create_dir_all(&vercel_dir).expect("temp .vercel dir should be created");
        fs::write(
            vercel_dir.join("project.json"),
            format!(r#"{{"projectName":"{project_name}"}}"#),
        )
        .expect("temp project metadata should be written");

        project_dir
    }
}
