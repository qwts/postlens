// User-supplied question set. Increment CACHE_VERSION in background.js when changing it.
export const QUESTIONS = {
  contains_factual_claim: {
    type: "noul",
    instructions: "Does this post assert at least one concrete factual claim that could in principle be externally verified?",
    criteria: {
      true: "The post makes at least one specific claim about reality that could be checked against external evidence.",
      false: "The post contains only opinion, preference, humor, rhetoric, or other content without an externally verifiable factual claim."
    }
  },
  sensationalism: {
    type: "score",
    instructions: "Rate how sensational the wording of this post is.",
    criteria: [
      "Neutral and primarily descriptive.",
      "Mildly emotive but still primarily informative.",
      "Noticeably promotional, persuasive, or emotionally framed.",
      "Strong exaggeration, hype, urgency, outrage, or clickbait framing.",
      "Extreme sensationalism dominated by alarm, absolutism, conspiracy framing, or engagement bait."
    ]
  },
  evidence_alignment: {
    type: "score",
    instructions: "Rate how well the factual claims in the post align with the evidence included in the supplied state. Do not assume a claim is true merely because it is stated.",
    criteria: [
      "The supplied evidence contradicts major factual claims.",
      "The supplied evidence provides little or no support for major factual claims.",
      "Some factual claims are supported while others remain unsupported.",
      "Most important factual claims are directly supported by the supplied evidence.",
      "The major factual claims are clearly and directly supported by the supplied evidence."
    ]
  },
  manipulation: {
    type: "score",
    instructions: "Rate the extent to which this post uses rhetorical manipulation rather than evidence to influence the reader.",
    criteria: [
      "No meaningful manipulative rhetoric.",
      "Minor persuasive framing.",
      "Moderate use of emotional or selective framing.",
      "Strong use of fear, outrage, tribal framing, false dichotomies, or misleading implication.",
      "Emotional coercion or deceptive framing dominates the post."
    ]
  },
  automation_signals: {
    type: "score",
    instructions: "Rate how strongly the combination of post language and account metadata exhibits characteristics commonly associated with automated, templated, spam-like, or coordinated social-media activity. Do not infer automation from verification, follower counts, posting volume, or promotional language alone.",
    criteria: [
      "No meaningful automation or coordination signals.",
      "Weak or isolated signals.",
      "Some characteristics consistent with templated or automated activity.",
      "Strong combination of textual and metadata signals.",
      "Very strong combination of signals consistent with automated or coordinated activity."
    ]
  },
  certainty_language: {
    type: "score",
    instructions: "Rate how strongly the post expresses certainty beyond what the supplied evidence substantiates.",
    criteria: [
      "Claims are appropriately qualified relative to the available evidence.",
      "Slightly stronger certainty than the evidence warrants.",
      "Moderate overstatement of certainty.",
      "Strong certainty despite limited support.",
      "Absolute or categorical certainty despite little or no supporting evidence."
    ]
  },
  post_type: {
    type: "choice",
    instructions: "Choose the category that best describes the primary function of this post.",
    criteria: {
      technical_reporting: "Primarily reports technical information, specifications, benchmarks, or product details.",
      enthusiastic_amplification: "Primarily shares real information while using excitement, hype, or promotional framing.",
      opinion: "Primarily expresses a belief, interpretation, or personal judgment.",
      persuasion: "Primarily attempts to convince the reader of a position or conclusion.",
      engagement_farming: "Primarily appears designed to maximize reactions, clicks, shares, or emotional engagement.",
      advertising: "Primarily promotes a product, service, organization, or commercial action.",
      humor_satire: "Primarily intended as humor, parody, or satire.",
      unclear: "No single primary function can be determined confidently."
    }
  },
  account_context: {
    type: "score",
    instructions: "Rate how much the available account metadata is consistent with an established topical technology account rather than a low-context or spam-like account. Do not treat account age, verification, follower counts, or posting volume as proof of authenticity.",
    criteria: [
      "Metadata strongly resembles a low-context, disposable, or spam-like account.",
      "Metadata provides weak evidence of an established topical account.",
      "Metadata is mixed or inconclusive.",
      "Metadata is reasonably consistent with an established topical account.",
      "Metadata is strongly consistent with an established topical technology account."
    ]
  }
};
