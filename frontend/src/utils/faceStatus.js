/** What a customer needs to know about being ready to pay, from real enrollment and model state. */
export function faceStatus(enrollment, model) {
  const total = enrollment.total_samples
  if (total === 0) {
    return { badge: 'PENDING', label: 'Not set up', text: 'Register your face to start paying with FacePay.', cta: 'Set up your face' }
  }
  if (model?.includes_you && !model.stale) {
    return { badge: 'SUCCESS', label: 'Ready', text: 'Your face is enrolled and the model includes you. You can pay with FacePay.', cta: 'Review face setup' }
  }
  if (model?.includes_you && model.stale) {
    return { badge: 'PENDING', label: 'Retrain needed', text: 'Your samples changed after the model was trained. Retrain to use the new ones.', cta: 'Retrain' }
  }
  if (!enrollment.eligible) {
    return {
      badge: 'PENDING', label: 'More samples needed',
      text: `${total} of ${enrollment.min_samples_to_train} samples captured. Capture a few more in different poses.`, cta: 'Continue face setup',
    }
  }
  return { badge: 'PENDING', label: 'Training needed', text: 'Your samples are ready. Train the model to finish setup.', cta: 'Train the model' }
}
